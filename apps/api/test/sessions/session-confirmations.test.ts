import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultAgent,
  createDefaultSession,
  getSession,
  jsonBody,
  listEvents,
  pollForEvent,
  sendEvents,
  type ErrorEnvelope,
  type EventJson,
  type PageJson,
  type SessionJson,
} from "./helpers";
import { enqueueModelScript, modelRequests, resetModelMock } from "../mock-model/client";

beforeAll(applyMigrations);
beforeEach(() => resetModelMock());

/** bash 为 always_ask 的会话(其余工具 always_allow) */
async function createAskSession(): Promise<SessionJson> {
  const agent = await createDefaultAgent({
    name: "ask-agent",
    model: "glm-5.3",
    tools: [
      {
        type: "agent_toolset_20260601",
        configs: [{ name: "bash", permission_policy: { type: "always_ask" } }],
      },
    ],
  });
  return createDefaultSession({ agent: agent.id });
}

async function eventList(sessionId: string): Promise<EventJson[]> {
  const page = await jsonBody<PageJson<EventJson>>(await listEvents(sessionId));
  return page.data;
}

/** 触发一次 always_ask 工具调用并等到挂起(requires_action),返回挂起事件与 tool_use */
async function suspendWithAskCall(sessionId: string, marker: string): Promise<{ idle: EventJson; toolUse: EventJson }> {
  await enqueueModelScript({
    match: marker,
    chunks: [{ content: "need a shell" }],
    tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: "echo yes" }) }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  await sendEvents(sessionId, [
    { type: "user.message", content: [{ type: "text", text: `please ${marker}` }] },
  ]);
  const events = await pollForEvent(
    sessionId,
    (list) => list.some((event) => event.type === "session.status_idle"),
  );
  const idle = events.find((event) => event.type === "session.status_idle")!;
  const toolUse = events.find((event) => event.type === "agent.tool_use")!;
  return { idle, toolUse };
}

describe("M3 确认挂起与恢复 — always_ask(§4.3)", () => {
  it("挂起:requires_action 带 event_ids,不执行工具,usage 照常落库,会话回 idle", async () => {
    const session = await createAskSession();
    const { idle, toolUse } = await suspendWithAskCall(session.id, "ask-run");

    expect((await eventList(session.id)).map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.message",
      "agent.tool_use",
      "session.usage",
      "session.status_idle",
    ]);
    expect(idle.stop_reason).toEqual({ type: "requires_action", event_ids: [toolUse.id] });
    expect((await eventList(session.id)).some((event) => event.type === "agent.tool_result")).toBe(false);
    expect((await modelRequests()).length).toBe(1); // 不再有后续模型调用
    const after = await jsonBody<SessionJson>(await getSession(session.id));
    expect(after.status).toBe("idle");
    expect(after.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0 });
  });

  it("allow:回 running 执行工具,新 turn 带着结果继续到 end_turn", async () => {
    const session = await createAskSession();
    const { toolUse } = await suspendWithAskCall(session.id, "ask-allow");

    const res = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: toolUse.id, result: "allow" },
    ]);
    expect(res.status).toBe(200);

    const events = await pollForEvent(
      session.id,
      (list) => list.filter((event) => event.type === "session.status_idle").length >= 2,
    );
    const tail = events.slice(events.findIndex((event) => event.type === "user.tool_confirmation"));
    expect(tail.map((event) => event.type)).toEqual([
      "user.tool_confirmation",
      "session.status_running",
      "agent.tool_result",
      "agent.thinking",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    const toolResult = tail.find((event) => event.type === "agent.tool_result")!;
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect((toolResult.content as Array<{ text: string }>)[0]!.text).toBe('mock:bash:{"command":"echo yes"}');
    const idles = events.filter((event) => event.type === "session.status_idle");
    expect(idles[idles.length - 1]!.stop_reason).toEqual({ type: "end_turn" });
    // 挂起 turn 的 usage(10/4)+ 续跑 turn 的 usage(缺省脚本 12/34)都进 D1 投影
    const after = await jsonBody<SessionJson>(await getSession(session.id));
    expect(after.usage).toEqual({ input_tokens: 22, output_tokens: 38, cache_read_input_tokens: 0 });
  });

  it("deny:不执行工具,合成含 deny_message 的 is_error 结果喂回模型", async () => {
    const session = await createAskSession();
    const { toolUse } = await suspendWithAskCall(session.id, "ask-deny");

    const res = await sendEvents(session.id, [
      {
        type: "user.tool_confirmation",
        tool_use_id: toolUse.id,
        result: "deny",
        deny_message: "use read-only queries instead",
      },
    ]);
    expect(res.status).toBe(200);

    const events = await pollForEvent(
      session.id,
      (list) => list.filter((event) => event.type === "session.status_idle").length >= 2,
    );
    const toolResult = events.filter((event) => event.type === "agent.tool_result")[0]!;
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolResult.is_error).toBe(true);
    expect(JSON.stringify(toolResult.content)).toContain("rejected by the user");
    expect(JSON.stringify(toolResult.content)).toContain("use read-only queries instead");
    const idles = events.filter((event) => event.type === "session.status_idle");
    expect(idles[idles.length - 1]!.stop_reason).toEqual({ type: "end_turn" });
    const requests = await modelRequests();
    expect(requests).toHaveLength(2); // 续跑的模型调用带着拒绝结果
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("rejected by the user");
  });

  it("部分确认不续跑:全部待审批处理完才回 running;确认按原顺序执行", async () => {
    const session = await createAskSession();
    await enqueueModelScript({
      match: "ask-partial",
      chunks: [],
      tool_calls: [
        { name: "bash", arguments: JSON.stringify({ command: "echo one" }) },
        { name: "bash", arguments: JSON.stringify({ command: "echo two" }) },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please ask-partial" }] },
    ]);
    const suspended = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    const idle = suspended.find((event) => event.type === "session.status_idle")!;
    const ids = (idle.stop_reason as { event_ids: string[] }).event_ids;
    expect(ids).toHaveLength(2);

    // 只确认第一条:不回 running,无第二次模型调用
    await sendEvents(session.id, [{ type: "user.tool_confirmation", tool_use_id: ids[0]!, result: "allow" }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await modelRequests()).length).toBe(1);
    expect((await jsonBody<SessionJson>(await getSession(session.id))).status).toBe("idle");

    // 确认第二条:续跑,两个 tool_result 按原顺序配对
    await sendEvents(session.id, [{ type: "user.tool_confirmation", tool_use_id: ids[1]!, result: "allow" }]);
    const events = await pollForEvent(
      session.id,
      (list) => list.filter((event) => event.type === "session.status_idle").length >= 2,
    );
    const results = events.filter((event) => event.type === "agent.tool_result");
    expect(results).toHaveLength(2);
    expect(results.map((event) => event.tool_use_id)).toEqual(ids);
    expect(JSON.stringify(results[0]!.content)).toContain("echo one");
    expect(JSON.stringify(results[1]!.content)).toContain("echo two");
  });

  it("无效确认:未知 id / 同批重复 / 已裁决,均 400", async () => {
    const session = await createAskSession();
    const { toolUse } = await suspendWithAskCall(session.id, "ask-invalid");

    const unknown = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: "sevt_not_pending", result: "allow" },
    ]);
    expect(unknown.status).toBe(400);
    expect(((await jsonBody<ErrorEnvelope>(unknown)).error).message).toContain("No pending tool confirmation");

    const duplicate = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: toolUse.id, result: "allow" },
      { type: "user.tool_confirmation", tool_use_id: toolUse.id, result: "deny" },
    ]);
    expect(duplicate.status).toBe(400);
    expect(((await jsonBody<ErrorEnvelope>(duplicate)).error).message).toContain("Duplicate confirmation");

    // 「已裁决」分支:两条待审批中先确认一条(行已裁决、集合未清空不续跑),重复确认同一条
    await enqueueModelScript({
      match: "ask-invalid",
      chunks: [],
      tool_calls: [
        { name: "bash", arguments: JSON.stringify({ command: "echo one" }) },
        { name: "bash", arguments: JSON.stringify({ command: "echo two" }) },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "more please ask-invalid" }] },
    ]);
    const second = await pollForEvent(
      session.id,
      (list) => list.filter((event) => event.type === "session.status_idle").length >= 2,
    );
    const ids = (second.filter((event) => event.type === "session.status_idle")[1]!.stop_reason as { event_ids: string[] })
      .event_ids;
    await sendEvents(session.id, [{ type: "user.tool_confirmation", tool_use_id: ids[0]!, result: "allow" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reconfirm = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: ids[0]!, result: "deny" },
    ]);
    expect(reconfirm.status).toBe(400);
    expect(((await jsonBody<ErrorEnvelope>(reconfirm)).error).message).toContain("already been confirmed");
  });

  it("逐出恢复重入确认链:裁决已持久化,重执行未完成的工具,不重复落结果", async () => {
    const session = await createAskSession();
    await enqueueModelScript({
      match: "ask-evict",
      chunks: [],
      tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: "slow-confirm" }) }],
      usage: { prompt_tokens: 6, completion_tokens: 6 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please ask-evict" }] },
    ]);
    const suspended = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    const toolUse = suspended.find((event) => event.type === "agent.tool_use")!;

    // 确认触发续跑(mock 工具睡 1.5s),窗口内模拟逐出 → 恢复入口重入确认链
    const res = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: toolUse.id, result: "allow" },
    ]);
    expect(res.status).toBe(200);
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.id));
    const evicted = await stub.simulateEvictionForTest();
    expect(evicted.ok).toBe(true);

    const events = await pollForEvent(
      session.id,
      (list) => list.filter((event) => event.type === "session.status_idle").length >= 2,
    );
    const results = events.filter((event) => event.type === "agent.tool_result");
    expect(results).toHaveLength(1); // 重执行但结果不重复(预生成 id + 执行代际)
    expect(results[0]!.tool_use_id).toBe(toolUse.id);
    expect((results[0]!.content as Array<{ text: string }>)[0]!.text).toContain("slow command finished");
    // 恰两次 status_running:挂起前的 turn 与续跑各一次(逐出重入不额外多发)
    expect(events.filter((event) => event.type === "session.status_running")).toHaveLength(2);
    const idles = events.filter((event) => event.type === "session.status_idle");
    expect(idles[idles.length - 1]!.stop_reason).toEqual({ type: "end_turn" });
  });
});

describe("M3 running 中追加消息(§4.4 收尾竞态)", () => {
  it("running 时追加的消息不打断当前请求,在后续迭代被消费", async () => {
    const agent = await createDefaultAgent({
      name: "backlog-agent",
      model: "glm-5.3",
      tools: [{ type: "agent_toolset_20260601" }],
    });
    const session = await createDefaultSession({ agent: agent.id });
    await enqueueModelScript({
      match: "backlog-probe",
      chunks: [{ content: "first", delayMs: 600 }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please backlog-probe one" }] },
    ]);
    // 首次模型调用在途(600ms 延迟块)时追加第二条消息:只落日志不打断
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "backlog-probe two" }] },
    ]);

    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    // 单个 turn:一次 status_running;收尾前积压检查驱动第二次迭代
    expect(events.filter((event) => event.type === "session.status_running")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("agent.message");
    const requests = (await modelRequests()).filter((request) =>
      JSON.stringify(request.body).includes("backlog-probe"),
    );
    expect(requests.length).toBe(2);
    // 消息序 = 事件序:追加消息在首个 assistant 终事件之前落库
    expect(requests[1]!.body.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("backlog-probe two");
    // 两条输入都被消费(processed_at 回填)
    expect(events.every((event) => event.type !== "user.message" || event.processed_at !== null)).toBe(
      true,
    );
  });
});
