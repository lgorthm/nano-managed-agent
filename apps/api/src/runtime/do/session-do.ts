/**
 * SESSION_DO — 会话运行时的单写者 Durable Object(docs/session/runtime.md §1)。
 * 职责:状态机(idle/running)、事件日志(append-only + id 去重)、SSE fan-out、
 * turn 执行宿主与 alarm 复用器。执行器(turn-executor.ts)经 TurnHost 消费本类;
 * M1 起执行器含真实模型循环,崩溃恢复(§6)在构造唤醒与 alarm 巡检两处触发。
 *
 * 与控制面的边界(§8):存在性/归档门禁在 service 侧查 D1 先行裁决;
 * D1 的 sessions.status 与 usage 三列是本类状态机的投影,迁移即时回写。
 */
import { DurableObject, tracing } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import {
  findSession,
  findSessionOutputsBySession,
  findSessionResourcesBySessionIds,
  findSkillVersion,
  getDb,
  listSkillFiles,
  type SessionUsageDelta,
  updateSessionRuntimeState,
} from '@nano/db';
import {
  BUILTIN_TOOL_DEFINITIONS,
  type DeltaEventType,
  type EventInput,
  type EventListFilters,
  type EventType,
  type JsonValue,
  type PersistedEventJson,
  resolveBuiltinTools,
  resolveWireModel,
  type SessionStatus,
  type StopReason,
  validateToolInvocation,
} from '@nano/shared';
import { log } from '@nano/shared/log';
import type { Env } from '../../env';
import { newEventId, newTurnId } from '../ids';
import { ModelHttpError } from '../model-client';
import { createToolRunner, type ToolRunner } from '../tools/runner';
import {
  initialTurnSnapshot,
  type PendingConfirmationRecord,
  parseTurnSnapshot,
  runTurn,
  type TurnModelConfig,
  type TurnResume,
  type TurnSnapshot,
} from './turn-executor';

/** SSE 订阅上限(§7):超出即 429,客户端补历史 + 重连自愈 */
const MAX_SUBSCRIBERS = 16;
/** SSE 心跳间隔(§7) */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** turn 保活心跳间隔(§5):fire-and-forget 执行期间出站 I/O 不计入平台空闲判定 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** DO RPC 错误约定:可预期错误以结果对象返回(不抛出——DO 侧异常会被测试基线记为 unhandled),worker 侧翻译回 ApiError */
export type DoResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

function doFailure<T>(status: number, message: string): DoResult<T> {
  return { ok: false, status, message };
}

/** 日志正文截断:Workers Logs 单条上限 256KB,错误体留几百字节足够定位 */
function truncateForLog(text: string, limit = 512): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

interface Subscriber {
  deltas: Set<DeltaEventType>;
  write(frame: string): Promise<void>;
  close(): void;
}

type Row = Record<string, string | number | bigint | ArrayBuffer | null>;

/** 输入事件的顶层载荷(信封字段之外);user.interrupt 无载荷 */
function inputEventPayload(event: EventInput): Record<string, unknown> {
  switch (event.type) {
    case 'user.message':
      return { content: event.content };
    case 'user.tool_confirmation':
      return {
        tool_use_id: event.tool_use_id,
        result: event.result,
        ...(event.deny_message !== undefined ? { deny_message: event.deny_message } : {}),
      };
    default:
      return {};
  }
}

export class SessionDo extends DurableObject<Env> {
  private status: SessionStatus = 'idle';
  private interruptFlag = false;
  private deleted = false;
  private turnActive = false;
  private subscribers: Subscriber[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 事件表当前最大 seq 的内存缓存(delta 帧的排序参考);null = 未初始化 */
  private lastSeq: number | null = null;
  /** 执行代际:startTurn / 恢复各持唯一 token,被取代的执行静默退出 */
  private currentExecutionToken = 0;
  /** 当前 turn 的开始时刻(active_seconds 计时;逐出丢失该值时少计一次,投影允许) */
  private turnStartedAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
    for (const row of this.query("SELECT value FROM session_state WHERE key = 'status'")) {
      if (
        row.value === 'running' ||
        row.value === 'idle' ||
        row.value === 'rescheduling' ||
        row.value === 'terminated'
      ) {
        this.status = row.value;
      }
    }
    // 构造唤醒 = 强制逐出后的恢复入口之一(§6,等价 onStart);无孤儿 turn 行时是廉价空查
    void this.recoverOrphanTurnIfAny().catch((err) => {
      log.error('session turn recovery on wake failed', { sessionId: this.sessionId(), err });
    });
  }

  /** 建表幂等(§2.4 / §4.1 的表结构);wipe 后同一实例继续存活,需重建空表 */
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        type         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at, seq);
      CREATE TABLE IF NOT EXISTS session_turns (
        turn_id    TEXT PRIMARY KEY,
        iteration  INTEGER NOT NULL,
        snapshot   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_confirmations (
        tool_use_id     TEXT PRIMARY KEY,  -- agent.tool_use event id (§2.1)
        name            TEXT NOT NULL,
        input_json      TEXT NOT NULL,
        result_event_id TEXT NOT NULL,     -- pre-generated tool_result event id
        decision        TEXT,              -- NULL = pending approval; allow / deny
        deny_message    TEXT,
        created_at      INTEGER NOT NULL
      );
    `);
  }

  // ---------- SQL 小工具(同步 SQLite;DO 内的运行时存储不属 packages/db 职责) ----------

  private query(sql: string, ...params: Array<string | number | null>): Iterable<Row> {
    return this.ctx.storage.sql.exec(sql, ...params) as unknown as Iterable<Row>;
  }

  private exec(sql: string, ...params: Array<string | number | null>): number {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    return cursor.rowsWritten;
  }

  /** DO 内日志的会话定位字段:fire-and-forget / alarm 执行不挂在用户请求上,
   *  Workers Logs 里必须自带 sessionId 才能把日志关联回会话(请求同步段的
   *  request_id 由平台 traces 自动关联,无需在此携带) */
  private sessionId(): string {
    return this.ctx.id.name ?? 'unnamed';
  }

  private setState(key: string, value: string): void {
    this.exec(
      'INSERT INTO session_state (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  // ---------- 事件日志(§2) ----------

  /**
   * 事件唯一写入口:INSERT OR IGNORE 按 id 去重(执行器重试的幂等兜底),落库后广播。
   * 产出事件的 processed_at 默认为产生时刻(产生即处理);排队语义由输入路径显式传 null。
   */
  private appendEvent(
    type: EventType,
    fields: Record<string, unknown>,
    options: { id?: string; processedAt?: string | null } = {},
  ): PersistedEventJson {
    const id = options.id ?? newEventId();
    const createdAt = new Date();
    const processedAt =
      options.processedAt !== undefined ? options.processedAt : createdAt.toISOString();
    const event: PersistedEventJson = {
      id,
      type,
      created_at: createdAt.toISOString(),
      processed_at: processedAt,
      ...fields,
    };
    const written = this.exec(
      'INSERT OR IGNORE INTO events (id, type, payload, created_at, processed_at) VALUES (?, ?, ?, ?, ?)',
      id,
      type,
      JSON.stringify(event),
      createdAt.getTime(),
      processedAt !== null ? Date.parse(processedAt) : null,
    );
    if (written > 0) this.lastSeq = this.estimateNextSeq(); // 真插入才推进(去重命中不动)
    this.broadcastFrame(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  }

  /** processed_at 回填(§2.1 的唯一可变字段例外);不重广播——订阅者已收排队帧 */
  private markProcessed(id: string, processedAt: string): void {
    for (const row of this.query('SELECT payload FROM events WHERE id = ?', id)) {
      if (typeof row.payload !== 'string') continue;
      const event = JSON.parse(row.payload) as PersistedEventJson;
      event.processed_at = processedAt;
      this.exec(
        'UPDATE events SET payload = ?, processed_at = ? WHERE id = ?',
        JSON.stringify(event),
        Date.parse(processedAt),
        id,
      );
    }
  }

  hasPendingUserMessages(): boolean {
    for (const _row of this.query(
      "SELECT 1 FROM events WHERE type = 'user.message' AND processed_at IS NULL LIMIT 1",
    )) {
      return true;
    }
    return false;
  }

  // ---------- RPC:发送事件(POST /events,§4.2) ----------

  /**
   * 追加输入事件并按需触发 turn;返回持久化后的输入事件(响应的 data 数组)。
   * 事件以 JSON 字符串过 RPC 边界:载荷含递归 JSON 值,字符串化让序列化显式且
   * 避开泛型机器的深度实例化(worker 侧 JSON.parse 回协议类型)。
   */
  async sendEvents(events: EventInput[]): Promise<DoResult<string[]>> {
    if (this.deleted) {
      return doFailure(409, 'Session storage has been deleted.');
    }
    const persisted: PersistedEventJson[] = [];
    let hasMessage = false;
    let hasConfirmation = false;
    const confirmedInBatch = new Set<string>();
    for (const event of events) {
      if (event.type === 'user.tool_confirmation') {
        // 权限文档:tool_use_id 必须恰在待审批集合中;同批同 id 只允许一条确认
        if (confirmedInBatch.has(event.tool_use_id)) {
          return doFailure(
            400,
            `Duplicate confirmation for tool_use_id "${event.tool_use_id}" in one request.`,
          );
        }
        confirmedInBatch.add(event.tool_use_id);
        const outcome = this.confirmPending(
          event.tool_use_id,
          event.result,
          event.deny_message ?? null,
        );
        if (outcome === 'missing') {
          return doFailure(
            400,
            `No pending tool confirmation for tool_use_id "${event.tool_use_id}".`,
          );
        }
        if (outcome === 'decided') {
          return doFailure(400, `Tool use "${event.tool_use_id}" has already been confirmed.`);
        }
        hasConfirmation = true;
      }
      persisted.push(
        this.appendEvent(event.type, inputEventPayload(event), {
          processedAt: null,
        }),
      );
      if (event.type === 'user.message') hasMessage = true;
      if (event.type === 'user.interrupt') this.interruptFlag = true;
    }
    if (hasConfirmation && this.allConfirmationsDecided()) {
      // 全部待审批都有裁决 → 回 running 续跑(§4.3);排队消息由续跑的 turn 一并消费
      void this.executeConfirmedTurn().catch((err) => {
        log.error('confirmed turn resume failed', { sessionId: this.sessionId(), err });
        this.appendEvent('session.error', {
          message: 'The confirmed turn failed to resume.',
        });
      });
      return {
        ok: true,
        value: persisted.map((event) => JSON.stringify(event)),
      };
    }
    if (hasMessage && this.status === 'idle') {
      this.startTurn();
    }
    return { ok: true, value: persisted.map((event) => JSON.stringify(event)) };
  }

  /** 记录一条裁决(行内持久化——逐出后恢复入口可重入);missing/decided 为无效确认 */
  private confirmPending(
    toolUseId: string,
    result: 'allow' | 'deny',
    denyMessage: string | null,
  ): 'updated' | 'missing' | 'decided' {
    for (const row of this.query(
      'SELECT decision FROM pending_confirmations WHERE tool_use_id = ? LIMIT 1',
      toolUseId,
    )) {
      if (row.decision === null) {
        this.exec(
          'UPDATE pending_confirmations SET decision = ?, deny_message = ? WHERE tool_use_id = ?',
          result,
          denyMessage,
          toolUseId,
        );
        return 'updated';
      }
      return 'decided';
    }
    return 'missing';
  }

  /** 待审批集合非空且每条都有裁决(有空缺时继续等待,§4.3「所有待审批事件都被处理后」) */
  private allConfirmationsDecided(): boolean {
    let any = false;
    for (const _row of this.query('SELECT 1 FROM pending_confirmations LIMIT 1')) {
      any = true;
      break;
    }
    if (!any) return false;
    for (const _row of this.query(
      'SELECT 1 FROM pending_confirmations WHERE decision IS NULL LIMIT 1',
    )) {
      return false;
    }
    return true;
  }

  // ---------- RPC:事件列表(GET /events,§2.4) ----------

  /** keyset 分页读取事件历史;过滤(types / created_at 边界)+ seq 单调序(事件以 JSON 字符串过 RPC) */
  async listEvents(params: {
    filters: EventListFilters;
    limit: number;
    order: 'asc' | 'desc';
    cursorSeq?: number;
  }): Promise<{ data: string[]; nextPageSeq: number | null }> {
    const filters = params.filters;
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filters.types !== undefined && filters.types.length > 0) {
      conditions.push(`type IN (${filters.types.map(() => '?').join(', ')})`);
      values.push(...filters.types);
    }
    if (filters.createdAtGt !== undefined) {
      conditions.push('created_at > ?');
      values.push(filters.createdAtGt);
    }
    if (filters.createdAtGte !== undefined) {
      conditions.push('created_at >= ?');
      values.push(filters.createdAtGte);
    }
    if (filters.createdAtLt !== undefined) {
      conditions.push('created_at < ?');
      values.push(filters.createdAtLt);
    }
    if (filters.createdAtLte !== undefined) {
      conditions.push('created_at <= ?');
      values.push(filters.createdAtLte);
    }
    if (params.cursorSeq !== undefined) {
      conditions.push(params.order === 'asc' ? 'seq > ?' : 'seq < ?');
      values.push(params.cursorSeq);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = [
      ...this.query(
        `SELECT seq, payload FROM events${where} ORDER BY seq ${params.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`,
        ...values,
        params.limit + 1,
      ),
    ];
    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((row) => String(row.payload)),
      nextPageSeq: hasMore && last ? Number(last.seq) : null,
    };
  }

  // ---------- RPC:SSE 订阅(GET /events/stream,§7) ----------

  /** 建立订阅:只推连接后的新事件(不回放);重连协议 = 列表补历史 + 按 id 去重 */
  async subscribe(deltas: DeltaEventType[]): Promise<DoResult<ReadableStream>> {
    if (this.subscribers.length >= MAX_SUBSCRIBERS) {
      // 触碰上限通常意味着客户端重连风暴或断开未退订,值得留痕
      log.warn('sse subscriber limit reached', {
        sessionId: this.sessionId(),
        subscribers: this.subscribers.length,
        max: MAX_SUBSCRIBERS,
      });
      return doFailure(429, 'Too many event stream subscribers for this session.');
    }
    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const subscriber: Subscriber = {
      deltas: new Set(deltas),
      write: (frame) => writer.write(encoder.encode(frame)),
      close: () => {
        this.removeSubscriber(subscriber);
        void writer.close().catch(() => undefined);
      },
    };
    this.subscribers.push(subscriber);
    this.startHeartbeat();
    // 立即写一帧心跳:客户端确认流已建立(注释帧,不携带事件语义)
    void subscriber.write(': ping\n\n').catch(() => this.removeSubscriber(subscriber));
    return { ok: true, value: readable };
  }

  /** 推送增量帧(仅流上存在、不落库;M1 的模型流式调用使用,§7 的 .delta 形态) */
  emitDelta(type: DeltaEventType, eventId: string, seq: number, text: string): void {
    const frame = {
      type: `${type}.delta`,
      event_id: eventId,
      seq,
      delta: { text },
    };
    this.broadcastFrame(`data: ${JSON.stringify(frame)}\n\n`, (subscriber) =>
      subscriber.deltas.has(type),
    );
  }

  private removeSubscriber(subscriber: Subscriber): void {
    const index = this.subscribers.indexOf(subscriber);
    if (index !== -1) this.subscribers.splice(index, 1);
    if (this.subscribers.length === 0) this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcastFrame(': ping\n\n');
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 广播一帧给全部(或经谓词筛选的)订阅者;写失败即剔除慢消费者(§7) */
  private broadcastFrame(frame: string, want?: (subscriber: Subscriber) => boolean): void {
    for (const subscriber of [...this.subscribers]) {
      if (want !== undefined && !want(subscriber)) continue;
      void subscriber.write(frame).catch(() => this.removeSubscriber(subscriber));
    }
  }

  // ---------- RPC:控制面事件与删除联动(§2.3 / §8) ----------

  /** 控制面外发事件;M0 只有更新端点的 session.updated */
  async appendControlEvent(type: 'session.updated'): Promise<DoResult<string>> {
    if (this.deleted) {
      return doFailure(409, 'Session storage has been deleted.');
    }
    return {
      ok: true,
      value: JSON.stringify(this.appendEvent(type, {}, { processedAt: new Date().toISOString() })),
    };
  }

  /** 删除联动:销毁沙箱 → 广播 session.deleted → 断开订阅 → 清空全部存储 */
  async wipe(): Promise<void> {
    await this.destroySandbox().catch((err) => {
      log.error('sandbox destroy on wipe failed', { sessionId: this.sessionId(), err });
    });
    this.deleted = true;
    this.turnActive = false;
    this.lastSeq = null;
    if (this.subscribers.length > 0) {
      this.broadcastFrame(
        `data: ${JSON.stringify({
          id: newEventId(),
          type: 'session.deleted',
          created_at: new Date().toISOString(),
          processed_at: null,
        })}\n\n`,
      );
      for (const subscriber of [...this.subscribers]) subscriber.close();
    }
    this.stopHeartbeat();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // deleteAll 连表一起删;同一实例若再被触达(幂等 id 不会复用,纯防御),表需为空存在态
    this.ensureSchema();
  }

  /**
   * 会话终态联动(§4.5):显式销毁沙箱,清掉容器与全部状态。
   * mock(测试)与未配置绑定时为空操作;沙箱可能从未创建,失败只记日志。
   */
  async destroySandbox(): Promise<void> {
    if (this.env.TOOL_SANDBOX_MOCK === '1' || this.env.SANDBOX === undefined) return;
    const sessionId = this.ctx.id.name;
    if (sessionId === undefined) return;
    try {
      await getSandbox(this.env.SANDBOX, sessionId).destroy();
    } catch (err) {
      log.error('sandbox destroy failed', { sessionId: this.sessionId(), err });
    }
  }

  // ---------- turn 生命周期(§4) ----------

  /** idle→running:落 status_running、插 turn 行(带完整初始检查点)、保活、fire-and-forget 执行 */
  private startTurn(): void {
    if (this.status !== 'idle' || this.turnActive) return;
    // 挂起待审批期间不开新 turn(§4.3):排队消息由确认链续跑的 turn 一并消费
    for (const _row of this.query('SELECT 1 FROM pending_confirmations LIMIT 1')) {
      return;
    }
    this.status = 'running';
    this.setState('status', 'running');
    this.appendEvent('session.status_running', {});
    void this.writeback({ status: 'running' });

    const turnId = newTurnId();
    const snapshot = initialTurnSnapshot(turnId);
    this.exec(
      'INSERT INTO session_turns (turn_id, iteration, snapshot, created_at) VALUES (?, ?, ?, ?)',
      turnId,
      0,
      JSON.stringify(snapshot),
      Date.now(),
    );
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.keepAlive();
    const token = ++this.currentExecutionToken;
    log.info('session turn started: message', { sessionId: this.sessionId(), turnId });
    // fire-and-forget:RPC 响应不等 turn 完成;keepAlive 兜住执行期的空闲逐出(§5)
    void this.runTurnSpanned(turnId, 'message', { iteration: 0, snapshot }).catch((err) =>
      this.turnFailed(turnId, token, err),
    );
  }

  /**
   * turn 执行统一挂 session.turn span:traces 瀑布里每段会话执行成为一个有名
   * 整体(属性带 sessionId/turnId/trigger),Workers Logs 里对应的生命周期行
   * (「session.turn OK」)也因此有了业务语义——不再只剩 d1_all 这类平台打点。
   * span 名保持固定(低基数),具体 id 进属性
   */
  private runTurnSpanned(
    turnId: string,
    trigger: 'message' | 'confirmation' | 'recovery',
    resume?: TurnResume,
  ): Promise<void> {
    return tracing.enterSpan('session.turn', async (span) => {
      span.setAttribute('app.session_id', this.sessionId());
      span.setAttribute('app.turn_id', turnId);
      span.setAttribute('app.turn_trigger', trigger);
      return runTurn(this, turnId, resume);
    });
  }

  private turnFailed(turnId: string, token: number, err: unknown): void {
    // 模型上游非 2xx:响应体是最关键的排障信息(quota / 参数错误等),
    // Error 序列化不输出自定义字段,须显式携带;截断防超 Workers Logs 单条上限
    if (err instanceof ModelHttpError) {
      log.error('session turn failed', {
        sessionId: this.sessionId(),
        turnId,
        modelUpstream: { status: err.status, body: truncateForLog(err.body) },
      });
    } else {
      log.error('session turn failed', { sessionId: this.sessionId(), turnId, err });
    }
    if (token !== this.currentExecutionToken) return; // 被取代的执行(逐出模拟/双重恢复)失败:静默
    this.turnActive = false;
    if (this.deleted) return;
    // 行已不存在 = turn 已终局(恢复路径与在途执行的竞态):只复位内存,不补发事件
    for (const _row of this.query(
      'SELECT 1 FROM session_turns WHERE turn_id = ? LIMIT 1',
      turnId,
    )) {
      // 分诊(M4):上游 HTTP 错误带状态码,连接/断流类给出错误摘要,均可恢复——
      // 会话回 idle,下一条消息照常驱动新 turn
      const message =
        err instanceof ModelHttpError
          ? `The model API request failed (HTTP ${err.status}).`
          : `The agent turn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.appendEvent('session.error', { message });
      void this.finishTurn(
        turnId,
        { type: 'interrupted' },
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
        },
      );
      return;
    }
  }

  // ---------- TurnHost 实现(turn-executor.ts 消费) ----------

  appendProducedEvent(
    type:
      | 'agent.thinking'
      | 'agent.message'
      | 'agent.tool_use'
      | 'agent.tool_result'
      | 'session.usage'
      | 'session.error'
      | 'system.message',
    fields: Record<string, unknown>,
    options: { id?: string } = {},
  ): void {
    this.appendEvent(type, fields, {
      id: options.id,
      processedAt: new Date().toISOString(),
    });
  }

  consumePendingUserMessages(): number {
    const ids: string[] = [];
    for (const row of this.query(
      "SELECT id FROM events WHERE type = 'user.message' AND processed_at IS NULL ORDER BY seq",
    )) {
      if (typeof row.id === 'string') ids.push(row.id);
    }
    const processedAt = new Date().toISOString();
    for (const id of ids) this.markProcessed(id, processedAt);
    return ids.length;
  }

  /** 细粒度检查点整体替换(§3):同步 SQL,无 await 间隙 */
  saveTurnSnapshot(turnId: string, iteration: number, snapshot: TurnSnapshot): void {
    this.exec(
      'UPDATE session_turns SET iteration = ?, snapshot = ? WHERE turn_id = ?',
      iteration,
      JSON.stringify(snapshot),
      turnId,
    );
  }

  loadEventsForContext(): PersistedEventJson[] {
    const events: PersistedEventJson[] = [];
    for (const row of this.query('SELECT payload FROM events ORDER BY seq ASC')) {
      if (typeof row.payload !== 'string') continue;
      try {
        events.push(JSON.parse(row.payload) as PersistedEventJson);
      } catch (err) {
        // 日志行损坏不应炸掉整个 turn:跳过该行(单写者下正常不可达),
        // 但上下文悄悄缺失必须留痕,否则模型行为异常无从归因
        log.warn('skipping corrupted event row', {
          sessionId: this.sessionId(),
          payload: truncateForLog(String(row.payload), 120),
          err,
        });
      }
    }
    return events;
  }

  /** 每 turn 一次:agent_config 快照(创建时固化,创建即冻结语义)+ env 凭据 + 工具定义 */
  async loadTurnConfig(): Promise<TurnModelConfig> {
    const sessionId = this.ctx.id.name;
    const row = sessionId !== undefined ? await findSession(getDb(this.env), sessionId) : null;
    const agentConfig = row?.agentConfig ?? {
      system: null as string | null,
      model: { id: 'glm-5.3' },
      tools: [],
    };
    // 模型服务经 AI Gateway REST API(chat completions):env 缺失给出可诊断的错误,
    // 经 runTurn 的 catch → turnFailed 落 session.error,会话回 idle
    if (this.env.CLOUDFLARE_API_TOKEN === undefined) {
      throw new Error('Model API is not configured: missing secret CLOUDFLARE_API_TOKEN.');
    }
    if (this.env.AI_GATEWAY_ID === undefined) {
      throw new Error('Model API is not configured: missing var AI_GATEWAY_ID.');
    }
    if (this.env.AI_API_BASE === undefined && this.env.CLOUDFLARE_ACCOUNT_ID === undefined) {
      throw new Error('Model API is not configured: missing var CLOUDFLARE_ACCOUNT_ID.');
    }
    const baseUrl =
      this.env.AI_API_BASE ??
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`;
    // always_ask 工具一并提供给模型(执行时才分叉挂起,§4.3)
    const resolved = resolveBuiltinTools(agentConfig.tools);
    const toolPermissions: Record<string, 'always_allow' | 'always_ask'> = {};
    for (const tool of resolved) toolPermissions[tool.name] = tool.permission;
    return {
      system: agentConfig.system ?? null,
      model: {
        baseUrl,
        apiKey: this.env.CLOUDFLARE_API_TOKEN,
        // 目录内 id 映射 wire 名称(存量 glm-5.3 保持不变);目录外 id 原样透传
        model: resolveWireModel(agentConfig.model.id),
        gatewayId: this.env.AI_GATEWAY_ID,
      },
      tools: resolved.map((tool) => BUILTIN_TOOL_DEFINITIONS[tool.name]),
      toolPermissions,
    };
  }

  /** 工具执行层(§4.5 注入边界):无可用工具或无会话上下文时返回 null */
  async createToolRunner(): Promise<ToolRunner | null> {
    const sessionId = this.ctx.id.name;
    if (sessionId === undefined) return null;
    const db = getDb(this.env);
    const row = await findSession(db, sessionId);
    if (row === null) return null;
    const resourcesBySession = await findSessionResourcesBySessionIds(db, [sessionId]);
    const resources = (resourcesBySession.get(sessionId) ?? []).map((resource) => ({
      fileId: resource.fileId,
      mountPath: resource.mountPath,
    }));
    const outputs = (await findSessionOutputsBySession(db, sessionId)).map((output) => ({
      fileId: output.fileId,
      path: output.path,
    }));
    const skills = [];
    for (const reference of row.agentConfig.skills) {
      if (reference.type !== 'custom') continue;
      const version = Number(reference.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      const versionRow = await findSkillVersion(db, reference.skill_id, version);
      const files = await listSkillFiles(db, reference.skill_id, version);
      if (versionRow !== null && files.length > 0) {
        skills.push({
          directory: versionRow.directory,
          files: files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        });
      }
    }
    return createToolRunner(this.env, {
      sessionId,
      resources,
      outputs,
      skills,
      packages: row.environmentSnapshot.packages ?? null,
    });
  }

  executionToken(): number {
    return this.currentExecutionToken;
  }

  isExecutionCurrent(token: number): boolean {
    return token === this.currentExecutionToken;
  }

  recordPendingConfirmations(records: PendingConfirmationRecord[]): void {
    const now = Date.now();
    for (const record of records) {
      this.exec(
        'INSERT OR IGNORE INTO pending_confirmations (tool_use_id, name, input_json, result_event_id, decision, deny_message, created_at) ' +
          'VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        record.toolUseId,
        record.name,
        record.inputJson,
        record.resultEventId,
        now,
      );
    }
  }

  /**
   * 待审批集合全部裁决后的续跑(§4.3):回 running → 逐条执行裁决(allow 经入参
   * 校验后执行;deny 合成含 deny_message 的拒绝结果)→ 删行 → 新 turn 让模型
   * 带着全部 tool 结果继续。裁决在行内持久化,逐出后由恢复入口重入本方法
   * (行还在 = 该条的 tool_result 未落库,幂等重执行)。
   */
  private async executeConfirmedTurn(): Promise<void> {
    if (this.turnActive || this.deleted) return;
    const decided: Array<{
      toolUseId: string;
      name: string;
      inputJson: string;
      resultEventId: string;
      decision: string;
      denyMessage: string | null;
    }> = [];
    for (const row of this.query(
      'SELECT tool_use_id, name, input_json, result_event_id, decision, deny_message FROM pending_confirmations ' +
        'WHERE decision IS NOT NULL ORDER BY rowid', // rowid = 挂起批次的插入序 = 模型调用序(同毫秒插入时 created_at 会平局)
    )) {
      decided.push({
        toolUseId: String(row.tool_use_id),
        name: String(row.name),
        inputJson: String(row.input_json),
        resultEventId: String(row.result_event_id),
        decision: String(row.decision),
        denyMessage: typeof row.deny_message === 'string' ? row.deny_message : null,
      });
    }
    if (decided.length === 0) return;
    log.info('session turn resumed: confirmation', {
      sessionId: this.sessionId(),
      confirmedTools: decided.length,
    });

    // 权限文档:「所有待审批事件都被处理后,会话回到 running;被允许的工具执行」。
    // 逐出恢复重入时 status 已是 running(session_state 恢复),不重复外发迁移事件;
    // 执行代际让被取代的确认执行(逐出模拟 / 双重恢复)静默退出
    const token = ++this.currentExecutionToken;
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    if (this.status !== 'running') {
      this.status = 'running';
      this.setState('status', 'running');
      this.appendEvent('session.status_running', {});
      void this.writeback({ status: 'running' });
    }
    this.keepAlive();

    const runner = await this.createToolRunner();
    let toolsRan = false;
    for (const entry of decided) {
      let content: string;
      let isError: boolean;
      if (entry.decision === 'deny') {
        content = `The tool call was rejected by the user${entry.denyMessage !== null ? `: ${entry.denyMessage}` : '.'}`;
        isError = true;
      } else {
        let input: JsonValue;
        try {
          input = JSON.parse(entry.inputJson) as JsonValue;
        } catch {
          input = { __invalid_json: entry.inputJson };
        }
        const invalid = validateToolInvocation(entry.name, input);
        if (invalid !== null) {
          content = invalid;
          isError = true;
        } else {
          const outcome =
            runner !== null
              ? await runner.run({
                  toolUseId: entry.toolUseId,
                  name: entry.name,
                  input,
                })
              : {
                  content: 'Tool execution is unavailable: no sandbox binding is configured.',
                  isError: true,
                };
          if (token !== this.currentExecutionToken) return; // 被取代:交由恢复重入
          content = outcome.content;
          isError = outcome.isError;
          toolsRan = true;
        }
      }
      this.appendEvent(
        'agent.tool_result',
        {
          tool_use_id: entry.toolUseId,
          content: [{ type: 'text', text: content }],
          ...(isError ? { is_error: true } : {}),
        },
        { id: entry.resultEventId, processedAt: new Date().toISOString() },
      );
      this.exec('DELETE FROM pending_confirmations WHERE tool_use_id = ?', entry.toolUseId);
    }
    if (toolsRan && runner !== null) await runner.harvestOutputs();

    // 新 turn:模型经事件日志装配到全部 tool 结果后继续
    const turnId = newTurnId();
    const snapshot = initialTurnSnapshot(turnId);
    this.exec(
      'INSERT INTO session_turns (turn_id, iteration, snapshot, created_at) VALUES (?, ?, ?, ?)',
      turnId,
      0,
      JSON.stringify(snapshot),
      Date.now(),
    );
    void this.runTurnSpanned(turnId, 'confirmation', { iteration: 0, snapshot }).catch((err) =>
      this.turnFailed(turnId, token, err),
    );
  }

  /** 终事件 seq 的估计值(delta 帧排序参考);真实 seq 以落库行为准 */
  estimateNextSeq(): number {
    if (this.lastSeq === null) {
      this.lastSeq = 0;
      for (const row of this.query('SELECT MAX(seq) AS max_seq FROM events')) {
        const max = Number(row.max_seq ?? 0);
        if (Number.isFinite(max)) this.lastSeq = max;
      }
    }
    return this.lastSeq + 1;
  }

  isInterrupted(): boolean {
    return this.interruptFlag;
  }

  isDeleted(): boolean {
    return this.deleted;
  }

  /**
   * turn 终局:删 turn 行(行删除是"已终局"的权威标记,重复 finish 幂等)→
   * status_idle(stop_reason)→ 状态机回 idle → D1 投影回写。
   * end_turn 后仍有积压输入时立即开新 turn(§4.4 的收尾竞态兜底);
   * interrupted 不续跑——积压留给下一条用户消息。
   */
  async finishTurn(
    turnId: string,
    stopReason: StopReason,
    usage: UsagePayloadInput,
  ): Promise<void> {
    const deletedRows = this.exec('DELETE FROM session_turns WHERE turn_id = ?', turnId);
    if (deletedRows === 0) return;
    this.turnActive = false;
    this.interruptFlag = false;
    // turn 完成行:业务终局与 token 用量。此前 DO 只有错误路径有日志,成功的
    // turn 在 Workers Logs 里完全不可见(只能去翻事件日志)
    log.info(`session turn finished: ${stopReason.type}`, {
      sessionId: this.sessionId(),
      turnId,
      stopReason: stopReason.type,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    });
    if (this.deleted) return;

    this.status = 'idle';
    this.setState('status', 'idle');
    this.appendEvent('session.status_idle', { stop_reason: stopReason });

    const usageDelta: SessionUsageDelta | undefined =
      usage.input_tokens !== 0 || usage.output_tokens !== 0 || usage.cache_read_input_tokens !== 0
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
          }
        : undefined;
    // stats 投影(M4):active 按 turn 实际时长累计(内存起点,逐出丢失则该次少计)
    const activeDelta =
      this.turnStartedAt !== null
        ? Math.max(0, (Date.now() - this.turnStartedAt) / 1000)
        : undefined;
    this.turnStartedAt = null;
    await this.writeback({
      status: 'idle',
      usageDelta,
      activeSecondsDelta: activeDelta,
    });

    if (stopReason.type === 'end_turn' && this.hasPendingUserMessages()) {
      this.startTurn();
    }
  }

  // ---------- alarm 复用器(§5):心跳续期 → 孤儿 turn 巡检 ----------

  /** 保活间隔可注入(测试 2s 才能等到巡检),默认 30s */
  private keepAliveIntervalMs(): number {
    const parsed = Number.parseInt(this.env.TURN_KEEPALIVE_INTERVAL_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : KEEPALIVE_INTERVAL_MS;
  }

  /** 刷新保活心跳;turn 执行期间按间隔续期 */
  private keepAlive(): void {
    void this.ctx.storage.setAlarm(Date.now() + this.keepAliveIntervalMs()).catch(() => undefined);
  }

  override async alarm(): Promise<void> {
    if (this.turnActive) {
      this.keepAlive();
      return;
    }
    await this.recoverOrphanTurnIfAny();
  }

  /**
   * 孤儿 turn 恢复(§6 策略 1:重发)——turn 行存在但内存无活跃 turn,即强制
   * 逐出后的现场。恢复动作:外发 system.message → 同 turnId/iteration 续跑,
   * 终事件 id 沿用 snapshot 预生成值(append 去重兜底);无孤儿行时为空查。
   */
  private async recoverOrphanTurnIfAny(): Promise<void> {
    if (this.turnActive || this.deleted) return;
    // 确认执行被逐出打断(有裁决的行仍在):先续跑确认链,turn 由其内部接管
    for (const _row of this.query(
      'SELECT 1 FROM pending_confirmations WHERE decision IS NOT NULL LIMIT 1',
    )) {
      await this.executeConfirmedTurn();
      return;
    }
    let turnId: string | null = null;
    let iteration = 0;
    let snapshot: TurnSnapshot | null = null;
    for (const row of this.query(
      'SELECT turn_id, iteration, snapshot FROM session_turns LIMIT 1',
    )) {
      if (typeof row.turn_id === 'string') turnId = row.turn_id;
      iteration = Number(row.iteration ?? 0);
      snapshot = parseTurnSnapshot(row.snapshot);
      break;
    }
    if (turnId === null) return;
    if (snapshot === null) {
      // 快照损坏(防御分支):从 iteration 0 重生成;数据损坏类事件值得留痕,
      // 它指示存储层出了问题,而不是常态业务分支
      log.error('turn snapshot corrupted; regenerating from iteration 0', {
        sessionId: this.sessionId(),
        turnId,
      });
    }

    this.turnActive = true;
    this.keepAlive();
    // 恢复意味着曾发生强制逐出(§6):异常但可自愈,warn 级留痕供观测平台告警
    log.warn('session turn recovered: eviction', { sessionId: this.sessionId(), turnId });
    if (this.status !== 'running') {
      // 逐出时状态机事实应为 running;防御性归一,保证续跑期间的门禁语义
      this.status = 'running';
      this.setState('status', 'running');
      this.appendEvent('session.status_running', {});
      void this.writeback({ status: 'running' });
    }
    this.appendEvent(
      'system.message',
      {
        content: 'The session recovered after an interruption; the in-flight turn was restarted.',
      },
      { processedAt: new Date().toISOString() },
    );
    const resume: TurnResume | undefined = snapshot !== null ? { iteration, snapshot } : undefined;
    const token = ++this.currentExecutionToken;
    void this.runTurnSpanned(turnId, 'recovery', resume).catch((err) =>
      this.turnFailed(turnId, token, err),
    );
  }

  /**
   * 测试专用:模拟强制逐出造成的内存丢失(turnActive 归零)并立即走真实恢复
   * 路径——与构造唤醒 / alarm 巡检触发的是同一个 recoverOrphanTurnIfAny。
   * 恢复路径是正常流程(§6),必须可测试;vitest 里无法真正逐出 DO 实例。
   */
  async simulateEvictionForTest(): Promise<DoResult<null>> {
    if (!this.turnActive) {
      return doFailure(409, 'No active turn in memory to evict.');
    }
    this.turnActive = false;
    await this.recoverOrphanTurnIfAny();
    return { ok: true, value: null };
  }

  // ---------- D1 投影回写(§8) ----------

  /** 失败只记日志:投影允许短暂落后,事实源在本 DO */
  private async writeback(patch: {
    status?: SessionStatus;
    usageDelta?: SessionUsageDelta;
    activeSecondsDelta?: number;
  }): Promise<void> {
    // idFromName 创建的实例 name 恒有值;newUniqueId 的实例才可能缺失
    const sessionId = this.ctx.id.name;
    if (sessionId === undefined) return;
    try {
      await updateSessionRuntimeState(getDb(this.env), {
        sessionId,
        status: patch.status,
        usageDelta: patch.usageDelta,
        activeSecondsDelta: patch.activeSecondsDelta,
        now: new Date(),
      });
    } catch (err) {
      log.error('session d1 writeback failed', { sessionId: this.sessionId(), err });
    }
  }
}

/** finishTurn 的 usage 形态(wire 的 UsagePayload) */
type UsagePayloadInput = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
};
