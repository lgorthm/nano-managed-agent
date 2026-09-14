import { describe, expect, it } from "vitest";
import {
  buildLedger,
  collapsibleSteps,
  collapsibleTurns,
  collapseRecords,
  deriveTimelineSpans,
  filterRecords,
  stepKey,
  timelineFocusKeys,
  type LedgerRecord,
} from "../src/web/lib/session-ledger";

const BASE = Date.parse("2026-09-14T10:00:00.000Z");
const at = (ms: number) => new Date(BASE + ms).toISOString();

let seq = 0;
function ev(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { id: `sevt_${seq}`, type, ...fields };
}
/** 重置事件 id 计数,使每个用例内 id 从 sevt_1 开始可预期 */
function resetSeq() {
  seq = 0;
}

/** 一轮典型的「用户输入 → 思考 → 消息 → 工具调用 → 结果」事件序列 */
function sampleEvents(): Array<Record<string, unknown>> {
  resetSeq();
  return [
    ev("user.message", { processed_at: at(0), content: [{ type: "text", text: "帮我看看这个仓库" }] }),
    ev("span.model_request_start", { processed_at: at(10) }),
    ev("agent.thinking", { processed_at: at(100), content: [{ type: "text", text: "先列目录" }] }),
    ev("span.model_request_end", { processed_at: at(200) }),
    ev("agent.message", { processed_at: at(220), content: [{ type: "text", text: "我来列一下目录" }] }),
    ev("agent.tool_use", { processed_at: at(300), name: "bash", input: { command: "ls -la" } }),
    ev("agent.tool_result", {
      processed_at: at(500),
      tool_use_id: "sevt_6",
      is_error: false,
      content: [{ type: "text", text: "README.md src/" }],
    }),
    ev("session.status_idle", { processed_at: at(600) }),
  ];
}

describe("buildLedger", () => {
  it("turn 划分:首个用户输入归 turn 1,后续输入递增;session.* 元事件不产出记录", () => {
    resetSeq();
    const events = [
      ...sampleEvents(),
      ev("user.message", { processed_at: at(700), content: [{ type: "text", text: "第二条" }] }),
      ev("session.usage", { processed_at: at(800), input_tokens: 10 }),
    ];
    const records = buildLedger(events);
    expect(records.map((r) => [r.turn, r.label])).toEqual([
      [1, "用户消息"],
      [1, "模型请求"],
      [1, "思考"],
      [1, "Agent 消息"],
      [1, "工具调用"],
      [2, "用户消息"],
    ]);
  });

  it("会话开头无输入前缀的孤儿事件并入 turn 1", () => {
    resetSeq();
    const records = buildLedger([
      ev("system.message", { processed_at: at(0), message: "系统提示" }),
      ev("user.message", { processed_at: at(10), content: [{ type: "text", text: "你好" }] }),
    ]);
    expect(records.map((r) => r.turn)).toEqual([1, 1]);
  });

  it("user.tool_confirmation 不开新 turn,归入当前循环", () => {
    resetSeq();
    const records = buildLedger([
      ev("user.message", { processed_at: at(0), content: [{ type: "text", text: "跑一下" }] }),
      ev("agent.tool_use", { processed_at: at(50), name: "bash", input: { command: "pwd" } }),
      ev("user.tool_confirmation", { processed_at: at(100), decision: "approve" }),
      ev("agent.tool_result", {
        processed_at: at(150),
        tool_use_id: "sevt_2",
        content: [{ type: "text", text: "/tmp" }],
      }),
    ]);
    expect(records.every((r) => r.turn === 1)).toBe(true);
  });

  it("step 划分:agent.message/thinking 开新 step,其后的工具行归属该 step;user/system/span 行 step 为 0", () => {
    resetSeq();
    const records = buildLedger(sampleEvents());
    expect(records.map((r) => [r.label, r.step])).toEqual([
      ["用户消息", 0],
      ["模型请求", 0],
      ["思考", 1],
      ["Agent 消息", 2],
      ["工具调用", 2],
    ]);
  });

  it("tool_use↔tool_result 配对为区间记录:end 取结果落地时间,isError 透传,摘要含工具名与结果预览", () => {
    resetSeq();
    const records = buildLedger(sampleEvents());
    const tool = records.find((r) => r.kind === "tool");
    expect(tool).toMatchObject({
      key: "sevt_6",
      startedAt: BASE + 300,
      endAt: BASE + 500,
      durationMs: 200,
      isError: false,
      toolName: "bash",
    });
    expect(tool?.summary).toContain("bash");
    expect(tool?.summary).toContain("ls -la");
    expect(tool?.summary).toContain("README.md src/");
    // 配对后的 tool_result 不再单独产出记录
    expect(records.filter((r) => r.key === "sevt_7")).toHaveLength(0);
  });

  it("失败的工具调用透传 is_error 并标记错误", () => {
    resetSeq();
    const records = buildLedger([
      ev("agent.tool_use", { processed_at: at(0), name: "bash", input: { command: "boom" } }),
      ev("agent.tool_result", {
        processed_at: at(40),
        tool_use_id: "sevt_1",
        is_error: true,
        content: [{ type: "text", text: "command not found" }],
      }),
    ]);
    expect(records[0]?.isError).toBe(true);
  });

  it("未配对的孤儿 tool_result 退化为瞬时记录", () => {
    resetSeq();
    const records = buildLedger([
      ev("agent.tool_result", {
        processed_at: at(0),
        tool_use_id: "sevt_missing",
        content: [{ type: "text", text: "结果" }],
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "tool", startedAt: BASE, endAt: BASE, durationMs: 0 });
  });

  it("span start↔end 配对为区间记录;孤立 end 退化为瞬时记录", () => {
    resetSeq();
    const records = buildLedger([
      ...sampleEvents(),
      ev("span.outcome_evaluation_end", { processed_at: at(900) }),
    ]);
    const request = records.find((r) => r.kind === "span" && r.label === "模型请求");
    expect(request).toMatchObject({ startedAt: BASE + 10, endAt: BASE + 200, durationMs: 190 });
    const orphan = records.find((r) => r.label === "结果评估结束");
    expect(orphan).toMatchObject({ kind: "span", durationMs: 0 });
  });

  it("排队中(processed_at 为空)的事件仍产出记录但 startedAt 为 null", () => {
    resetSeq();
    const records = buildLedger([
      ev("user.message", { content: [{ type: "text", text: "排队中的消息" }] }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.startedAt).toBeNull();
    expect(records[0]?.durationMs).toBeNull();
  });
});

describe("deriveTimelineSpans", () => {
  it("sequence 模式:每条可定位记录等宽顺排,turn 边界在首记录处", () => {
    resetSeq();
    const records = buildLedger([
      ev("user.message", { processed_at: at(0), content: [{ type: "text", text: "一" }] }),
      ev("agent.message", { processed_at: at(10), content: [{ type: "text", text: "二" }] }),
      ev("agent.message", { processed_at: at(20), content: [{ type: "text", text: "三" }] }),
      ev("user.message", { processed_at: at(30), content: [{ type: "text", text: "四" }] }),
      ev("agent.message", { processed_at: at(40), content: [{ type: "text", text: "五" }] }),
    ]);
    const model = deriveTimelineSpans(records, "sequence");
    expect(model?.spans.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(model).toMatchObject({ start: 0, end: 5 });
    expect(model?.turnBoundaries).toEqual([
      { turn: 1, time: 0 },
      { turn: 2, time: 3 },
    ]);
  });

  it("duration 模式:压缩空闲间隙,连续块紧贴铺开", () => {
    resetSeq();
    const records = buildLedger([
      ev("user.message", { processed_at: at(0), content: [{ type: "text", text: "一" }] }),
      ev("agent.tool_use", { processed_at: at(0), name: "bash", input: { command: "a" } }),
      ev("agent.tool_result", { processed_at: at(100), tool_use_id: "sevt_2", content: [{ type: "text", text: "r" }] }),
      ev("agent.message", { processed_at: at(10_000), content: [{ type: "text", text: "远处的消息" }] }),
    ]);
    const model = deriveTimelineSpans(records, "duration");
    expect(model).not.toBeNull();
    const byKey = new Map(model!.spans.map((s) => [s.key, s]));
    // user.message [0,0]、tool [0,100] 无空隙;agent.message 在 10000,累计被移除的空闲为 9900
    // 投影域仍以首块真实时刻为起点(压缩只平移空闲,不归零)
    expect(byKey.get("sevt_1")).toMatchObject({ start: BASE, end: BASE });
    expect(byKey.get("sevt_2")).toMatchObject({ start: BASE, end: BASE + 100 });
    expect(byKey.get("sevt_4")).toMatchObject({ start: BASE + 100, end: BASE + 100 });
    expect(model).toMatchObject({ start: BASE, end: BASE + 100 });
  });

  it("无可定位记录(全部排队中)时返回 null", () => {
    resetSeq();
    const records = buildLedger([ev("user.message", { content: [{ type: "text", text: "排队" }] })]);
    expect(deriveTimelineSpans(records, "sequence")).toBeNull();
    expect(deriveTimelineSpans(records, "duration")).toBeNull();
  });
});

describe("timelineFocusKeys", () => {
  it("选出与选区闭区间相交的记录 key", () => {
    resetSeq();
    const model = deriveTimelineSpans(
      buildLedger([
        ev("agent.message", { processed_at: at(0), content: [{ type: "text", text: "一" }] }),
        ev("agent.message", { processed_at: at(10), content: [{ type: "text", text: "二" }] }),
        ev("agent.message", { processed_at: at(20), content: [{ type: "text", text: "三" }] }),
      ]),
      "sequence",
    )!;
    const keys = timelineFocusKeys(model, { start: 1.5, end: 2.5 });
    expect([...keys]).toEqual(["sevt_2", "sevt_3"]);
  });
});

describe("filterRecords", () => {
  const records: LedgerRecord[] = buildLedger([
    ...sampleEvents(),
    ev("user.message", { processed_at: at(700), content: [{ type: "text", text: "再来一条" }] }),
  ]);

  it("span 记录只进时间线,不进台账", () => {
    expect(filterRecords(records, "all", "").some((r) => r.kind === "span")).toBe(false);
  });

  it("按泳道过滤", () => {
    const tools = filterRecords(records, "tool", "");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((r) => r.lane === "tool")).toBe(true);
  });

  it("关键词匹配事件类型 / 事件 id / 摘要文本(大小写不敏感)", () => {
    expect(filterRecords(records, "all", "agent.tool_use")).toHaveLength(1);
    expect(filterRecords(records, "all", "sevt_6")).toHaveLength(1);
    expect(filterRecords(records, "all", "README")).toHaveLength(1);
    expect(filterRecords(records, "all", "不存在的关键词")).toHaveLength(0);
  });
});

describe("collapseRecords", () => {
  function richEvents(): Array<Record<string, unknown>> {
    seq = 0;
    return [
      ev("user.message", { processed_at: at(0), content: [{ type: "text", text: "整理这个项目" }] }),
      ev("agent.thinking", { processed_at: at(10), content: [{ type: "text", text: "第一步" }] }),
      ev("agent.tool_use", { processed_at: at(20), name: "bash", input: { command: "ls" } }),
      ev("agent.tool_result", { processed_at: at(30), tool_use_id: "sevt_3", content: [{ type: "text", text: "a b" }] }),
      ev("agent.tool_use", { processed_at: at(40), name: "read", input: { path: "a" } }),
      ev("agent.tool_result", { processed_at: at(50), tool_use_id: "sevt_5", content: [{ type: "text", text: "内容" }] }),
      ev("agent.message", { processed_at: at(60), content: [{ type: "text", text: "第二步说明" }] }),
      ev("agent.tool_use", { processed_at: at(70), name: "bash", input: { command: "wc -l" } }),
      ev("agent.tool_result", { processed_at: at(80), tool_use_id: "sevt_8", content: [{ type: "text", text: "42" }] }),
    ];
  }

  it("step 内工具行 ≥ 2 才可折叠;turn 记录数 ≥ 3 才可折叠", () => {
    resetSeq();
    const records = filterRecords(buildLedger(richEvents()), "all", "");
    expect(collapsibleTurns(records)).toEqual(new Set([1]));
    // turn 1 step 1 有两个工具行(bash、read);step 2 只有一个,不可折叠
    expect(collapsibleSteps(records)).toEqual(new Set([stepKey(1, 1)]));
  });

  it("折叠 turn:保留首条记录 + 一条摘要行,首行 turnStart、摘要行 turnEnd", () => {
    resetSeq();
    const records = filterRecords(buildLedger(richEvents()), "all", "");
    const rows = collapseRecords(records, new Set([1]), new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "sevt_1", record: { label: "用户消息" }, turnStart: true, turnEnd: false });
    expect(rows[1]).toMatchObject({ height: 20, record: null, turnStart: false, turnEnd: true });
    expect(rows[1]?.collapsed?.kind).toBe("turn");
    expect(rows[1]?.collapsed?.text).toContain("工具调用");
  });

  it("折叠 step:模型输出行保留,其后连续工具行折为一条摘要行", () => {
    resetSeq();
    const records = filterRecords(buildLedger(richEvents()), "all", "");
    const rows = collapseRecords(records, new Set(), new Set([stepKey(1, 1)]));
    // user + thinking + step1 摘要 + message(step2) + tool(step2) = 5 行
    expect(rows.map((r) => r.key)).toEqual(["sevt_1", "sevt_2", `step:${stepKey(1, 1)}\0summary`, "sevt_7", "sevt_8"]);
    const summary = rows[2]!;
    expect(summary.collapsed?.text).toBe("… 2 次调用: bash、read");
    expect(summary.turnEnd).toBe(false);
  });

  it("未折叠时行序与记录一一对应,turn 首末行标记正确", () => {
    resetSeq();
    const records = filterRecords(buildLedger(richEvents()), "all", "");
    const rows = collapseRecords(records, new Set(), new Set());
    expect(rows).toHaveLength(records.length);
    expect(rows[0]?.turnStart).toBe(true);
    expect(rows[rows.length - 1]?.turnEnd).toBe(true);
    expect(rows.slice(1, -1).every((r) => !r.turnStart && !r.turnEnd)).toBe(true);
  });
});
