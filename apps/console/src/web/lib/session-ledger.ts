/**
 * 会话事件台账数据层:把会话事件流编译为「turn → step → 记录」三层的台账模型,
 * 并提供时间线投影(顺序/耗时两种模式)、泳道+搜索过滤、turn/step 折叠等纯函数变换。
 * 分层方法参考 ui-trajectory:每层只依赖上层输出,渲染组件不做数据变换;
 * 折叠与过滤都返回新数组(折叠即数据变换),渲染层对折叠状态无感知。
 *
 * turn:一次用户输入到下一次用户输入之间的全部事件;user.message/interrupt/define_outcome 开启新 turn,
 * user.tool_confirmation 是审批回复、属于当前循环,不开新 turn;会话开头无输入前缀的孤儿事件并入 turn 1。
 * step:turn 内每条 agent.message/agent.thinking 开启一个 step,step 包含该行及其后连续的工具行。
 */

/** 三泳道:输入(用户侧)/模型(agent 输出与请求)/工具(调用与结果) */
export type LedgerLane = 'input' | 'model' | 'tool';

/** 台账记录的展示类别(闭合集合,渲染层按此选图标与配色) */
export type LedgerKind = 'user' | 'system' | 'message' | 'thinking' | 'tool' | 'span' | 'error';

/** 时间线水平投影模式:sequence 每条记录等宽顺排;duration 按真实耗时并压缩空闲间隙 */
export type TimelineMode = 'sequence' | 'duration';

/** 台账中的一条记录:一个事件,或 tool_use↔tool_result / span start↔end 配对合成的区间 */
export interface LedgerRecord {
  /** 稳定身份:优先事件 id(配对记录用起始事件的 id),与页面选中态共享 */
  key: string;
  eventId: string | null;
  lane: LedgerLane;
  kind: LedgerKind;
  /** 中文标签(如「工具调用」「用户消息」) */
  label: string;
  /** 台账单行摘要;工具行为「工具名 · 参数 → 结果」两段式 */
  summary: string;
  /** 开始时刻(epoch ms);null 表示排队中(processed_at 未回填),不进时间线 */
  startedAt: number | null;
  /** 结束时刻;瞬时事件等于 startedAt;配对缺失或排队中为 null */
  endAt: number | null;
  /** end - start,非负;瞬时为 0;未知为 null */
  durationMs: number | null;
  isError: boolean;
  /** 1-based turn 序号 */
  turn: number;
  /** turn 内 1-based step 序号;0 表示不属于任何 step(user/system/span 行) */
  step: number;
  toolName?: string;
  /** 原始事件(tool 配对记录指向 tool_use,span 配对记录指向 end 事件),详情面板消费 */
  raw: Record<string, unknown>;
}

/** 事件类型 → 类别与泳道;不在表内且非 span.* 的事件不产出记录(session.* 元事件等) */
const KIND_OF_TYPE: Record<string, { kind: LedgerKind; lane: LedgerLane }> = {
  'user.message': { kind: 'user', lane: 'input' },
  'user.interrupt': { kind: 'user', lane: 'input' },
  'user.tool_confirmation': { kind: 'user', lane: 'input' },
  'user.define_outcome': { kind: 'user', lane: 'input' },
  'system.message': { kind: 'system', lane: 'input' },
  'agent.thread_context_compacted': { kind: 'system', lane: 'input' },
  'agent.thread_message_received': { kind: 'system', lane: 'model' },
  'agent.thread_message_sent': { kind: 'system', lane: 'model' },
  'agent.message': { kind: 'message', lane: 'model' },
  'agent.thinking': { kind: 'thinking', lane: 'model' },
  'agent.tool_use': { kind: 'tool', lane: 'tool' },
  'agent.mcp_tool_use': { kind: 'tool', lane: 'tool' },
  'agent.custom_tool_use': { kind: 'tool', lane: 'tool' },
  'agent.tool_result': { kind: 'tool', lane: 'tool' },
  'agent.mcp_tool_result': { kind: 'tool', lane: 'tool' },
  'user.tool_result': { kind: 'tool', lane: 'tool' },
  'user.custom_tool_result': { kind: 'tool', lane: 'tool' },
  'session.error': { kind: 'error', lane: 'model' },
};

const TYPE_LABELS: Record<string, string> = {
  'user.message': '用户消息',
  'user.interrupt': '打断',
  'user.tool_confirmation': '工具确认',
  'user.define_outcome': '定义结果',
  'user.tool_result': '工具结果(用户)',
  'user.custom_tool_result': '自定义工具结果',
  'system.message': '系统消息',
  'agent.thread_context_compacted': '上下文压缩',
  'agent.thread_message_received': '线程消息(收)',
  'agent.thread_message_sent': '线程消息(发)',
  'agent.message': 'Agent 消息',
  'agent.thinking': '思考',
  'agent.tool_use': '工具调用',
  'agent.tool_result': '工具结果',
  'agent.mcp_tool_use': 'MCP 工具调用',
  'agent.mcp_tool_result': 'MCP 工具结果',
  'agent.custom_tool_use': '自定义工具调用',
  'span.model_request_start': '模型请求',
  'span.model_request_end': '模型请求结束',
  'span.outcome_evaluation_start': '结果评估',
  'span.outcome_evaluation_end': '结果评估结束',
  'session.error': '会话错误',
};

/** 开启新 turn 的用户输入类型(工具确认是审批回复,归入当前循环) */
const TURN_OPENING_TYPES = new Set(['user.message', 'user.interrupt', 'user.define_outcome']);

/** 开启新 step 的模型输出类型 */
const STEP_OPENING_TYPES = new Set(['agent.message', 'agent.thinking']);

const TOOL_USE_TYPES = new Set(['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use']);
const TOOL_RESULT_TYPES = new Set([
  'agent.tool_result',
  'agent.mcp_tool_result',
  'user.tool_result',
  'user.custom_tool_result',
]);
const SPAN_END_OF: Record<string, string> = {
  'span.model_request_start': 'span.model_request_end',
  'span.outcome_evaluation_start': 'span.outcome_evaluation_end',
};

/** 摘要文本最大长度:超出部分截断加省略号,避免对超长载荷做完整序列化 */
const SUMMARY_MAX_CHARS = 120;

function epochOf(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 压缩空白并截断的单行文本 */
function snippet(text: string, max = SUMMARY_MAX_CHARS): string | undefined {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length === 0) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 任意值的安全序列化预览(字符串原样,其余 JSON 化;失败或空值返回 undefined) */
function previewJson(value: unknown, max = SUMMARY_MAX_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== 'string' || text.length === 0) return undefined;
  return snippet(text, max);
}

/** 从 content 块数组或顶层 text/message 提取摘要首行 */
function textDetail(record: Record<string, unknown>): string | undefined {
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const s = snippet((block as { text: string }).text);
        if (s) return s;
      }
    }
    return undefined;
  }
  return (
    snippet(typeof record.text === 'string' ? record.text : '') ??
    snippet(typeof record.message === 'string' ? record.message : '')
  );
}

export function formatSpanDuration(ms: number): string {
  if (ms <= 0) return '0 毫秒';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * 把会话事件编译为台账记录:tool_use 与对应 tool_result 合并为区间记录,
 * span start/end 配对为区间记录;数组顺序即时间顺序(history 正序 + live 追加)。
 * 排队中(processed_at 为空)的事件仍产出记录,但 startedAt 为 null、不进时间线投影。
 */
export function buildLedger(events: Array<Record<string, unknown>>): LedgerRecord[] {
  // tool_use 事件 id → result 的落地时间与错误标记(§2:tool_use 的 id 即 tool_use_id)
  const resultByUseId = new Map<
    string,
    { at: number | null; isError: boolean; raw: Record<string, unknown> }
  >();
  for (const event of events) {
    if (!TOOL_RESULT_TYPES.has(String(event.type))) continue;
    resultByUseId.set(String(event.tool_use_id), {
      at: epochOf(event.processed_at),
      isError: event.is_error === true,
      raw: event,
    });
  }

  const records: LedgerRecord[] = [];
  const pairedUseIds = new Set<string>();
  let turn = 0;
  let step = 0;
  let pendingSpanStart: { type: string; record: LedgerRecord } | null = null;

  events.forEach((event, index) => {
    const type = typeof event.type === 'string' ? event.type : 'event';
    const label = TYPE_LABELS[type] ?? type;

    // turn/step 计数先于记录产出:开 turn 的输入自身属于新 turn
    if (TURN_OPENING_TYPES.has(type)) {
      turn += 1;
      step = 0;
    } else if (STEP_OPENING_TYPES.has(type)) {
      step += 1;
    }
    const currentTurn = Math.max(turn, 1);

    const at = epochOf(event.processed_at);
    const key = typeof event.id === 'string' ? event.id : `${type}-${index}`;
    const base = {
      key,
      eventId: typeof event.id === 'string' ? event.id : null,
      label,
      turn: currentTurn,
      raw: event,
      startedAt: at,
    };

    if (TOOL_USE_TYPES.has(type)) {
      pairedUseIds.add(key);
      const result = resultByUseId.get(key);
      const name = typeof event.name === 'string' ? event.name : 'tool';
      const inputPreview = previewJson(event.input);
      const resultPreview = result ? textDetail(result.raw) : undefined;
      const summary = resultPreview
        ? `${name} · ${inputPreview ?? ''} → ${resultPreview}`.replace(' ·  ', ' · ')
        : inputPreview
          ? `${name} · ${inputPreview}`
          : name;
      records.push({
        ...base,
        lane: 'tool',
        kind: 'tool',
        summary,
        endAt: result?.at ?? null,
        durationMs: result?.at != null && at !== null ? Math.max(0, result.at - at) : null,
        isError: result?.isError ?? false,
        step,
        toolName: name,
      });
      return;
    }
    if (TOOL_RESULT_TYPES.has(type)) {
      // 已并入配对区间记录的 result 不再单独出块
      if (typeof event.tool_use_id === 'string' && pairedUseIds.has(event.tool_use_id)) return;
      records.push({
        ...base,
        lane: 'tool',
        kind: 'tool',
        summary: textDetail(event) ?? label,
        endAt: at,
        durationMs: at !== null ? 0 : null,
        isError: event.is_error === true,
        step,
      });
      return;
    }
    if (SPAN_END_OF[type]) {
      // span 起始:立即产出「进行中」区间记录,保证台账顺序与事件顺序一致;配对结束时回填
      records.push({
        ...base,
        lane: 'model',
        kind: 'span',
        summary: label,
        endAt: null,
        durationMs: null,
        isError: false,
        step: 0,
      });
      // 刚 push 完必然存在,索引访问的类型收窄交给运行时不变式
      pendingSpanStart = { type, record: records[records.length - 1]! };
      return;
    }
    if (type.startsWith('span.')) {
      const pending =
        pendingSpanStart && SPAN_END_OF[pendingSpanStart.type] === type ? pendingSpanStart : null;
      pendingSpanStart = null;
      if (pending) {
        // 回填结束时刻与耗时(记录身份保持为起始事件)
        pending.record.endAt = at;
        pending.record.durationMs =
          at !== null && pending.record.startedAt !== null
            ? Math.max(0, at - pending.record.startedAt)
            : null;
        return;
      }
      // 孤立 end / ongoing 心跳:退化为瞬时记录
    }

    const mapped = type.startsWith('span.')
      ? { kind: 'span' as const, lane: 'model' as const }
      : KIND_OF_TYPE[type];
    if (!mapped) return;
    // message/thinking/error 继承当前 step(折叠用);user/system/span 行不属于任何 step
    const inheritStep =
      mapped.kind === 'message' || mapped.kind === 'thinking' || mapped.kind === 'error';
    records.push({
      ...base,
      ...mapped,
      summary: textDetail(event) ?? label,
      endAt: at,
      durationMs: at !== null ? 0 : null,
      isError: type === 'session.error',
      step: inheritStep ? step : 0,
    });
  });
  return records;
}

// ---------------------------------------------------------------------------
// 时间线投影
// ---------------------------------------------------------------------------

/** 时间线选区:投影域坐标上的闭区间 */
export interface TimelineRange {
  start: number;
  end: number;
}

/** 一条记录投影到时间线域后的块 */
export interface TimelineSpan {
  key: string;
  lane: LedgerLane;
  kind: LedgerKind;
  label: string;
  summary: string;
  isError: boolean;
  /** 所属 turn(1-based),hover 提示用 */
  turn: number;
  /** 投影域坐标(模式相关) */
  start: number;
  end: number;
  /** 真实开始时刻与耗时(投影坐标外的展示信息) */
  startedAt: number | null;
  durationMs: number | null;
}

/** turn 边界在时间线域上的投影位置(该 turn 首个可定位记录处) */
export interface TimelineTurnBoundary {
  turn: number;
  time: number;
}

export interface TimelineModel {
  start: number;
  end: number;
  spans: TimelineSpan[];
  turnBoundaries: TimelineTurnBoundary[];
}

function spanOf(record: LedgerRecord): TimelineSpan {
  const start = record.startedAt as number;
  return {
    key: record.key,
    lane: record.lane,
    kind: record.kind,
    label: record.label,
    summary: record.summary,
    isError: record.isError,
    turn: record.turn,
    start,
    end: start + Math.max(0, record.durationMs ?? 0),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
  };
}

/**
 * 把台账记录投影为时间线模型。
 * sequence:每条可定位记录等宽 1 单位顺排,看事件密度与顺序节奏(默认)。
 * duration:按 startedAt+duration 投影真实耗时,并压缩无事件的空闲间隙
 *   (按 start 排序,coveredUntil 累计被移除的 idle,每条块平移各自累计偏移)。
 * 无可定位记录时返回 null。
 */
export function deriveTimelineSpans(
  records: LedgerRecord[],
  mode: TimelineMode,
): TimelineModel | null {
  const positioned = records.filter((record) => record.startedAt !== null);
  if (positioned.length === 0) return null;

  if (mode === 'sequence') {
    const spans: TimelineSpan[] = [];
    const turnBoundaries: TimelineTurnBoundary[] = [];
    const seenTurns = new Set<number>();
    positioned.forEach((record, index) => {
      if (!seenTurns.has(record.turn)) {
        seenTurns.add(record.turn);
        turnBoundaries.push({ turn: record.turn, time: index });
      }
      spans.push({ ...spanOf(record), start: index, end: index + 1 });
    });
    return { start: 0, end: spans.length, spans, turnBoundaries };
  }

  // duration 模式:先按真实时间铺开,再压缩空闲
  const raw = positioned.map(spanOf);
  const removedIdleBySpan = new Map<TimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...raw].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans = raw.map((span) => {
    const offset = removedIdleBySpan.get(span) ?? 0;
    return { ...span, start: span.start - offset, end: span.end - offset };
  });
  const turnBoundaries: TimelineTurnBoundary[] = [];
  const seenTurns = new Set<number>();
  for (const span of spans) {
    if (!seenTurns.has(span.turn)) {
      seenTurns.add(span.turn);
      turnBoundaries.push({ turn: span.turn, time: span.start });
    }
  }
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/**
 * 选出与选区相交(闭区间)的记录 key 集合,用于台账行「选区外压暗」。
 */
export function timelineFocusKeys(model: TimelineModel, range: TimelineRange): Set<string> {
  return new Set(
    model.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.key),
  );
}

// ---------------------------------------------------------------------------
// 台账过滤与折叠
// ---------------------------------------------------------------------------

/** 关键词是否命中记录(事件类型/事件 id/摘要,大小写不敏感包含);span 记录不参与台账搜索 */
export function recordMatchesSearch(record: LedgerRecord, keyword: string): boolean {
  const query = keyword.trim().toLowerCase();
  if (!query) return true;
  if (record.kind === 'span') return false;
  const type = typeof record.raw.type === 'string' ? record.raw.type : '';
  return (
    type.toLowerCase().includes(query) ||
    (record.eventId?.toLowerCase().includes(query) ?? false) ||
    record.summary.toLowerCase().includes(query)
  );
}

/**
 * 台账记录过滤:排除 span 类(只进时间线不进台账),再按泳道与关键词过滤。
 * 关键词匹配行为见 recordMatchesSearch,与旧列表行为对齐。
 */
export function filterRecords(
  records: LedgerRecord[],
  lane: LedgerLane | 'all',
  keyword: string,
): LedgerRecord[] {
  return records.filter(
    (record) =>
      record.kind !== 'span' &&
      (lane === 'all' || record.lane === lane) &&
      recordMatchesSearch(record, keyword),
  );
}

/** 台账渲染行:内容行(30px)或折叠摘要行(20px);turnStart/turnEnd 驱动竖轨首末 */
export interface LedgerRow {
  key: string;
  height: number;
  /** 内容行对应的记录;摘要行为 null */
  record: LedgerRecord | null;
  /** 折叠摘要行的展开目标与文案 */
  collapsed?: {
    kind: 'turn' | 'step';
    turn: number;
    step: number;
    text: string;
  };
  turnStart: boolean;
  turnEnd: boolean;
}

/** step 折叠集合的复合键 */
export function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

/** 可折叠的 turn(台账记录数 ≥ 3,折叠后至少剩首行 + 摘要行) */
export function collapsibleTurns(records: LedgerRecord[]): Set<number> {
  const counts = new Map<number, number>();
  for (const record of records) {
    counts.set(record.turn, (counts.get(record.turn) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= 3).map(([turn]) => turn));
}

/** 可折叠的 step(该 step 内工具行 ≥ 2) */
export function collapsibleSteps(records: LedgerRecord[]): Set<string> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.step > 0 && record.kind === 'tool') {
      const key = stepKey(record.turn, record.step);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= 2).map(([key]) => key));
}

function turnSummaryText(turnRecords: LedgerRecord[]): string {
  const rest = turnRecords.length - 1;
  const steps = new Set(turnRecords.filter((r) => r.step > 0).map((r) => r.step)).size;
  const tools = turnRecords.filter((r) => r.kind === 'tool').length;
  const parts: string[] = [];
  if (steps > 0) parts.push(`${steps} 步`);
  parts.push(`${rest} 条记录`);
  if (tools > 0) parts.push(`${tools} 次工具调用`);
  return `… ${parts.join(' · ')}`;
}

function stepSummaryText(toolRecords: LedgerRecord[]): string {
  const names: string[] = [];
  for (const record of toolRecords) {
    if (record.toolName && !names.includes(record.toolName)) names.push(record.toolName);
  }
  const shown = names.length > 4 ? `${names.slice(0, 4).join('、')} 等` : names.join('、');
  return `… ${toolRecords.length} 次调用${shown ? `: ${shown}` : ''}`;
}

/**
 * 折叠即数据变换:被折叠 turn 只保留首条记录 + 一条摘要行;
 * 未折叠 turn 中被折叠 step 的首条模型输出保留,其后连续工具行折为一条摘要行。
 * 输入应为 filterRecords 的结果(无 span 记录)。
 */
export function collapseRecords(
  records: LedgerRecord[],
  collapsedTurns: ReadonlySet<number>,
  collapsedSteps: ReadonlySet<string>,
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let index = 0;
  while (index < records.length) {
    const first = records[index];
    if (!first) break;
    const turn = first.turn;
    let next = index;
    while (next < records.length && records[next]?.turn === turn) next += 1;
    const turnRecords = records.slice(index, next);
    const turnHead = turnRecords[0];
    if (collapsedTurns.has(turn) && turnRecords.length >= 3 && turnHead) {
      rows.push({
        key: turnHead.key,
        height: 30,
        record: turnHead,
        turnStart: true,
        turnEnd: false,
      });
      rows.push({
        key: `turn:${turn}\0summary`,
        height: 20,
        record: null,
        collapsed: {
          kind: 'turn',
          turn,
          step: 0,
          text: turnSummaryText(turnRecords),
        },
        turnStart: false,
        turnEnd: true,
      });
      index = next;
      continue;
    }

    const lastRow = turnRecords.length - 1;
    let position = 0;
    while (position < turnRecords.length) {
      const record = turnRecords[position];
      if (!record) break;
      const isTurnEnd = position === lastRow;
      // step 折叠:模型输出行后的连续工具行折为一条摘要行
      if (
        record.kind === 'tool' &&
        record.step > 0 &&
        collapsedSteps.has(stepKey(record.turn, record.step))
      ) {
        let toolEnd = position;
        while (
          toolEnd < turnRecords.length &&
          turnRecords[toolEnd]?.kind === 'tool' &&
          turnRecords[toolEnd]?.step === record.step
        ) {
          toolEnd += 1;
        }
        const toolRecords = turnRecords.slice(position, toolEnd);
        rows.push({
          key: `step:${stepKey(record.turn, record.step)}\0summary`,
          height: 20,
          record: null,
          collapsed: {
            kind: 'step',
            turn: record.turn,
            step: record.step,
            text: stepSummaryText(toolRecords),
          },
          turnStart: false,
          turnEnd: toolEnd - 1 === lastRow,
        });
        position = toolEnd;
        continue;
      }
      rows.push({
        key: record.key,
        height: 30,
        record,
        turnStart: position === 0,
        turnEnd: isTurnEnd,
      });
      position += 1;
    }
    index = next;
  }
  return rows;
}
