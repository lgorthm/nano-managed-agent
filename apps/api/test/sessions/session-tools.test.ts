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
  type EventJson,
  type PageJson,
  type SessionJson,
} from "./helpers";
import { enqueueModelScript, modelRequests, resetModelMock } from "../mock-model/client";

beforeAll(applyMigrations);
beforeEach(() => resetModelMock());

/** 带 always_allow 全量工具集的 Agent(M2 执行侧默认形态) */
async function createToolSession(body?: Record<string, unknown>): Promise<SessionJson> {
  const agent = await createDefaultAgent({
    name: "tool-agent",
    model: "glm-5.3",
    tools: [{ type: "agent_toolset_20260601" }],
  });
  return createDefaultSession({ agent: agent.id, ...body });
}

async function eventList(sessionId: string): Promise<EventJson[]> {
  const page = await jsonBody<PageJson<EventJson>>(await listEvents(sessionId));
  return page.data;
}

async function requestsFor(text: string) {
  return (await modelRequests()).filter((request) => JSON.stringify(request.body).includes(text));
}

describe("M2 工具循环 — always_allow 闭环", () => {
  it("bash 工具往返:tool_use/tool_result 配对(事件 id 即 tool_use_id),usage 跨迭代累计", async () => {
    const session = await createToolSession();
    await enqueueModelScript({
      match: "use-bash",
      chunks: [{ content: "let me check" }],
      tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await enqueueModelScript({
      match: "use-bash",
      chunks: [{ content: "ran it" }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    });

    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please use-bash now" }] },
    ]);
    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );

    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.message",
      "agent.tool_use",
      "agent.tool_result",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    const toolUse = events.find((event) => event.type === "agent.tool_use")!;
    expect(toolUse.id).toMatch(/^sevt_/);
    expect(toolUse.name).toBe("bash");
    expect(toolUse.input).toEqual({ command: "echo hi" });
    const toolResult = events.find((event) => event.type === "agent.tool_result")!;
    expect(toolResult.tool_use_id).toBe(toolUse.id); // §2.1:tool_use_id 就是事件 id
    expect(toolResult.content).toEqual([{ type: "text", text: 'mock:bash:{"command":"echo hi"}' }]);
    expect(toolResult.is_error).toBeUndefined();
    // usage 跨两次模型调用累计(10+7 / 5+2),事件与 D1 投影一致
    const usage = events.find((event) => event.type === "session.usage")!;
    expect(usage).toMatchObject({ input_tokens: 17, output_tokens: 7, cache_read_input_tokens: 0 });
    const after = await jsonBody<SessionJson>(await getSession(session.id));
    expect(after.usage).toEqual({ input_tokens: 17, output_tokens: 7, cache_read_input_tokens: 0 });

    // 第二次模型调用:tools 上行七个内置工具;上下文含 tool_calls 轮与 tool 轮
    const requests = await requestsFor("use-bash");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.tools?.map((tool: { function: { name: string } }) => tool.function.name).sort())
      .toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    const secondMessages = requests[1]!.body.messages;
    // agent.message 与 tool_use 分属两条 assistant 轮(映射约定),tool 轮回指
    expect(secondMessages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
    ]);
    const toolCallMessage = secondMessages[2]!;
    expect(toolCallMessage.tool_calls).toHaveLength(1);
    expect(toolCallMessage.tool_calls![0]!.function.name).toBe("bash");
    expect(secondMessages[3]!.tool_call_id).toBe(toolUse.id);
    expect(secondMessages[3]!.content).toContain("mock:bash");
  });

  it("一次响应多个工具调用:逐个执行按序配对", async () => {
    const session = await createToolSession();
    await enqueueModelScript({
      match: "multi-tools",
      chunks: [],
      tool_calls: [
        { name: "ls", arguments: "{}" },
        { name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please multi-tools" }] },
    ]);
    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    const toolUses = events.filter((event) => event.type === "agent.tool_use");
    const toolResults = events.filter((event) => event.type === "agent.tool_result");
    expect(toolUses.map((event) => event.name)).toEqual(["ls", "read"]);
    expect(toolResults.map((event) => event.tool_use_id)).toEqual(toolUses.map((event) => event.id));

    const requests = await requestsFor("multi-tools");
    const toolMessages = requests[1]!.body.messages.filter((m: { role: string }) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });

  it("非法入参与未知工具:is_error 的 tool_result 喂回模型,turn 继续", async () => {
    const session = await createToolSession();
    await enqueueModelScript({
      match: "bad-input",
      chunks: [],
      tool_calls: [
        { name: "bash", arguments: "{broken json" },
        { name: "nope", arguments: "{}" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please bad-input" }] },
    ]);
    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    const toolResults = events.filter((event) => event.type === "agent.tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.every((event) => event.is_error === true)).toBe(true);
    const text = JSON.stringify(toolResults.map((event) => event.content));
    expect(text).toContain("Invalid arguments");
    expect(text).toContain("Unknown tool");
    expect(events.find((event) => event.type === "session.status_idle")!.stop_reason).toEqual({
      type: "end_turn",
    });
  });

  it("always_ask 工具不进入模型 tools(M3 挂起语义就位前的 M2 行为)", async () => {
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
    const session = await createDefaultSession({ agent: agent.id });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "ask-policy probe" }] },
    ]);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "session.status_idle"));
    const [request] = await requestsFor("ask-policy probe");
    const names = request!.body.tools?.map((tool) => tool.function.name);
    expect(names).toHaveLength(6);
    expect(names).not.toContain("bash");
  });
});

describe("M2 工具循环 — 中断与恢复", () => {
  it("中断在途:执行完再停,未开始的合成 is_error 结果补齐配对", async () => {
    const session = await createToolSession();
    await enqueueModelScript({
      match: "interrupt-tool",
      chunks: [],
      tool_calls: [
        { name: "bash", arguments: JSON.stringify({ command: "slow one" }) },
        { name: "bash", arguments: JSON.stringify({ command: "echo after" }) },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please interrupt-tool" }] },
    ]);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "agent.tool_use"));
    await sendEvents(session.id, [{ type: "user.interrupt" }]);

    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.tool_use",
      "agent.tool_use",
      "user.interrupt",
      "agent.tool_result",
      "agent.tool_result",
      "session.status_idle",
    ]);
    const results = events.filter((event) => event.type === "agent.tool_result");
    expect(results[0]!.is_error).toBeUndefined(); // 在途的执行完再停(§4.4)
    expect(JSON.stringify(results[0]!.content)).toContain("slow command finished");
    expect(results[1]!.is_error).toBe(true); // 未开始的跳过执行
    expect(events.find((event) => event.type === "session.status_idle")!.stop_reason).toEqual({
      type: "interrupted",
    });
    expect((await requestsFor("interrupt-tool")).length).toBe(1); // 不再有后续模型调用
  });

  it("逐出后恢复:重入工具批次,重执行未完成的工具,终事件无重复", async () => {
    const session = await createToolSession();
    await enqueueModelScript({
      match: "recover-tools",
      chunks: [],
      tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: "slow work" }) }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "please recover-tools" }] },
    ]);
    // 等到 tool_use 已落库、执行在途(slow = 1.5s)再模拟逐出
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "agent.tool_use"));

    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.id));
    const result = await stub.simulateEvictionForTest();
    expect(result.ok).toBe(true);

    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.tool_use",
      "system.message",
      "agent.tool_result",
      "agent.thinking",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    // §6 幂等:重入不产生重复终事件(预生成 id + append 去重 + 执行代际静默旧执行)
    expect(events.filter((event) => event.type === "agent.tool_use")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.tool_result")).toHaveLength(1);
    expect(events.find((event) => event.type === "session.status_idle")!.stop_reason).toEqual({
      type: "end_turn",
    });
    // 恢复只补执行与后续模型调用,不重放首次模型请求
    const requests = await requestsFor("recover-tools");
    expect(requests).toHaveLength(2);
  });
});
