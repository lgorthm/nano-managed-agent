/**
 * SESSION_DO — 会话运行时的单写者 Durable Object(docs/session/runtime.md §1)。
 * 职责:状态机(idle/running)、事件日志(append-only + id 去重)、SSE fan-out、
 * turn 执行宿主与 alarm 复用器。M0 的执行体是 null-turn(turn-executor.ts);
 * M1 在执行器内插入模型调用,本类不动。
 *
 * 与控制面的边界(§8):存在性/归档门禁在 service 侧查 D1 先行裁决;
 * D1 的 sessions.status 与 usage 三列是本类状态机的投影,迁移即时回写。
 */
import { DurableObject } from "cloudflare:workers";
import { getDb, updateSessionRuntimeState, type SessionUsageDelta } from "@nano/db";
import type {
  DeltaEventType,
  EventInput,
  EventListFilters,
  EventType,
  PersistedEventJson,
  SessionStatus,
  StopReason,
} from "@nano/shared";
import type { Env } from "../../env";
import { newEventId, newTurnId } from "../ids";
import { runTurn } from "./turn-executor";

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

interface Subscriber {
  deltas: Set<DeltaEventType>;
  write(frame: string): Promise<void>;
  close(): void;
}

type Row = Record<string, string | number | bigint | ArrayBuffer | null>;

/** 输入事件的顶层载荷(信封字段之外);user.interrupt 无载荷 */
function inputEventPayload(event: EventInput): Record<string, unknown> {
  switch (event.type) {
    case "user.message":
      return { content: event.content };
    case "user.tool_confirmation":
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
  private status: SessionStatus = "idle";
  private interruptFlag = false;
  private deleted = false;
  private turnActive = false;
  private subscribers: Subscriber[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
    for (const row of this.query("SELECT value FROM session_state WHERE key = 'status'")) {
      if (row.value === "running" || row.value === "idle" || row.value === "rescheduling" || row.value === "terminated") {
        this.status = row.value;
      }
    }
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

  private setState(key: string, value: string): void {
    this.exec(
      "INSERT INTO session_state (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
    const processedAt = options.processedAt !== undefined ? options.processedAt : createdAt.toISOString();
    const event: PersistedEventJson = {
      id,
      type,
      created_at: createdAt.toISOString(),
      processed_at: processedAt,
      ...fields,
    };
    this.exec(
      "INSERT OR IGNORE INTO events (id, type, payload, created_at, processed_at) VALUES (?, ?, ?, ?, ?)",
      id,
      type,
      JSON.stringify(event),
      createdAt.getTime(),
      processedAt !== null ? Date.parse(processedAt) : null,
    );
    this.broadcastFrame(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  }

  /** processed_at 回填(§2.1 的唯一可变字段例外);不重广播——订阅者已收排队帧 */
  private markProcessed(id: string, processedAt: string): void {
    for (const row of this.query("SELECT payload FROM events WHERE id = ?", id)) {
      if (typeof row.payload !== "string") continue;
      const event = JSON.parse(row.payload) as PersistedEventJson;
      event.processed_at = processedAt;
      this.exec(
        "UPDATE events SET payload = ?, processed_at = ? WHERE id = ?",
        JSON.stringify(event),
        Date.parse(processedAt),
        id,
      );
    }
  }

  private hasPendingUserMessages(): boolean {
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
      return doFailure(409, "Session storage has been deleted.");
    }
    const persisted: PersistedEventJson[] = [];
    let hasMessage = false;
    for (const event of events) {
      if (event.type === "user.tool_confirmation") {
        // M0 无 always_ask 工具,待审批集合恒空;确认一律无效(M3 挂起语义就位后放开)
        return doFailure(400, `No pending tool confirmation for tool_use_id "${event.tool_use_id}".`);
      }
      persisted.push(this.appendEvent(event.type, inputEventPayload(event), { processedAt: null }));
      if (event.type === "user.message") hasMessage = true;
      if (event.type === "user.interrupt") this.interruptFlag = true;
    }
    if (hasMessage && this.status === "idle") {
      this.startTurn();
    }
    return { ok: true, value: persisted.map((event) => JSON.stringify(event)) };
  }

  // ---------- RPC:事件列表(GET /events,§2.4) ----------

  /** keyset 分页读取事件历史;过滤(types / created_at 边界)+ seq 单调序(事件以 JSON 字符串过 RPC) */
  async listEvents(params: {
    filters: EventListFilters;
    limit: number;
    order: "asc" | "desc";
    cursorSeq?: number;
  }): Promise<{ data: string[]; nextPageSeq: number | null }> {
    const filters = params.filters;
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filters.types !== undefined && filters.types.length > 0) {
      conditions.push(`type IN (${filters.types.map(() => "?").join(", ")})`);
      values.push(...filters.types);
    }
    if (filters.createdAtGt !== undefined) {
      conditions.push("created_at > ?");
      values.push(filters.createdAtGt);
    }
    if (filters.createdAtGte !== undefined) {
      conditions.push("created_at >= ?");
      values.push(filters.createdAtGte);
    }
    if (filters.createdAtLt !== undefined) {
      conditions.push("created_at < ?");
      values.push(filters.createdAtLt);
    }
    if (filters.createdAtLte !== undefined) {
      conditions.push("created_at <= ?");
      values.push(filters.createdAtLte);
    }
    if (params.cursorSeq !== undefined) {
      conditions.push(params.order === "asc" ? "seq > ?" : "seq < ?");
      values.push(params.cursorSeq);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = [
      ...this.query(
        `SELECT seq, payload FROM events${where} ORDER BY seq ${params.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
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
      return doFailure(429, "Too many event stream subscribers for this session.");
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
    void subscriber.write(": ping\n\n").catch(() => this.removeSubscriber(subscriber));
    return { ok: true, value: readable };
  }

  /** 推送增量帧(仅流上存在、不落库;M1 的模型流式调用使用,§7 的 .delta 形态) */
  emitDelta(type: DeltaEventType, eventId: string, seq: number, text: string): void {
    const frame = { type: `${type}.delta`, event_id: eventId, seq, delta: { text } };
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
      this.broadcastFrame(": ping\n\n");
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
  async appendControlEvent(type: "session.updated"): Promise<DoResult<string>> {
    if (this.deleted) {
      return doFailure(409, "Session storage has been deleted.");
    }
    return { ok: true, value: JSON.stringify(this.appendEvent(type, {}, { processedAt: new Date().toISOString() })) };
  }

  /** 删除联动:广播 session.deleted → 断开订阅 → 清空全部存储(事件历史随之终结) */
  async wipe(): Promise<void> {
    this.deleted = true;
    this.turnActive = false;
    if (this.subscribers.length > 0) {
      this.broadcastFrame(
        `data: ${JSON.stringify({
          id: newEventId(),
          type: "session.deleted",
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

  // ---------- turn 生命周期(§4) ----------

  /** idle→running:落 status_running、插 turn 行、保活、fire-and-forget 执行 */
  private startTurn(): void {
    if (this.status !== "idle" || this.turnActive) return;
    this.status = "running";
    this.setState("status", "running");
    this.appendEvent("session.status_running", {});
    void this.writeback({ status: "running" });

    const turnId = newTurnId();
    this.exec(
      "INSERT INTO session_turns (turn_id, iteration, snapshot, created_at) VALUES (?, ?, ?, ?)",
      turnId,
      0,
      JSON.stringify({ iteration: 0 }),
      Date.now(),
    );
    this.turnActive = true;
    this.keepAlive();
    // fire-and-forget:RPC 响应不等 turn 完成;keepAlive 兜住执行期的空闲逐出(§5)
    void runTurn(this, turnId).catch((err) => this.turnFailed(turnId, err));
  }

  private turnFailed(turnId: string, err: unknown): void {
    console.error("session turn failed:", err);
    this.turnActive = false;
    if (this.deleted) return;
    this.appendEvent("session.error", { message: "The agent turn failed unexpectedly." });
    void this.finishTurn(turnId, { type: "interrupted" }, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  }

  // ---------- TurnHost 实现(turn-executor.ts 消费) ----------

  appendProducedEvent(
    type:
      | "agent.thinking"
      | "agent.message"
      | "agent.tool_use"
      | "agent.tool_result"
      | "session.usage"
      | "session.error"
      | "system.message",
    fields: Record<string, unknown>,
  ): void {
    this.appendEvent(type, fields, { processedAt: new Date().toISOString() });
  }

  consumePendingUserMessages(): number {
    const ids: string[] = [];
    for (const row of this.query(
      "SELECT id FROM events WHERE type = 'user.message' AND processed_at IS NULL ORDER BY seq",
    )) {
      if (typeof row.id === "string") ids.push(row.id);
    }
    const processedAt = new Date().toISOString();
    for (const id of ids) this.markProcessed(id, processedAt);
    return ids.length;
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
  async finishTurn(turnId: string, stopReason: StopReason, usage: UsagePayloadInput): Promise<void> {
    const deletedRows = this.exec("DELETE FROM session_turns WHERE turn_id = ?", turnId);
    if (deletedRows === 0) return;
    this.turnActive = false;
    this.interruptFlag = false;
    if (this.deleted) return;

    this.status = "idle";
    this.setState("status", "idle");
    this.appendEvent("session.status_idle", { stop_reason: stopReason });

    const usageDelta: SessionUsageDelta | undefined =
      usage.input_tokens !== 0 || usage.output_tokens !== 0 || usage.cache_read_input_tokens !== 0
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
          }
        : undefined;
    await this.writeback({ status: "idle", usageDelta });

    if (stopReason.type === "end_turn" && this.hasPendingUserMessages()) {
      this.startTurn();
    }
  }

  // ---------- alarm 复用器(§5):心跳续期 → 孤儿 turn 巡检 ----------

  /** 刷新保活心跳;turn 执行期间按间隔续期 */
  private keepAlive(): void {
    void this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS).catch(() => undefined);
  }

  override async alarm(): Promise<void> {
    if (this.turnActive) {
      this.keepAlive();
      return;
    }
    // 孤儿巡检:turn 行存在但内存无活跃 turn = 强制逐出后的恢复入口(§6)
    for (const row of this.query("SELECT turn_id FROM session_turns LIMIT 1")) {
      const turnId = row.turn_id;
      if (typeof turnId === "string" && !this.deleted) {
        this.recoverOrphanTurn(turnId);
      }
      break;
    }
  }

  /**
   * M0 恢复策略:null-turn 无模型调用、无可重放——外发恢复通知并以 interrupted 收尾。
   * M1 起按 snapshot 走 §6 的完整策略(重发 / 部分落盘 + 合成继续)。
   */
  private recoverOrphanTurn(turnId: string): void {
    this.appendEvent(
      "system.message",
      { content: "The session recovered after an interruption; the in-flight turn was ended." },
      { processedAt: new Date().toISOString() },
    );
    this.exec("DELETE FROM session_turns WHERE turn_id = ?", turnId);
    this.turnActive = false;
    if (this.status === "running") {
      this.status = "idle";
      this.setState("status", "idle");
      this.appendEvent("session.status_idle", { stop_reason: { type: "interrupted" } });
    }
    void this.writeback({ status: "idle" });
  }

  // ---------- D1 投影回写(§8) ----------

  /** 失败只记日志:投影允许短暂落后,事实源在本 DO */
  private async writeback(patch: { status?: SessionStatus; usageDelta?: SessionUsageDelta }): Promise<void> {
    // idFromName 创建的实例 name 恒有值;newUniqueId 的实例才可能缺失
    const sessionId = this.ctx.id.name;
    if (sessionId === undefined) return;
    try {
      await updateSessionRuntimeState(getDb(this.env), {
        sessionId,
        status: patch.status,
        usageDelta: patch.usageDelta,
        now: new Date(),
      });
    } catch (err) {
      console.error("session d1 writeback failed:", err);
    }
  }
}

/** finishTurn 的 usage 形态(wire 的 UsagePayload) */
type UsagePayloadInput = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
};
