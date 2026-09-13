import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  API_KEY,
  applyMigrations,
  archiveSessionInDb,
  createDefaultSession,
  deleteSessionViaApi,
  getSession,
  jsonBody,
  listEvents,
  openEventStream,
  pollForEvent,
  sendEvents,
  updateSession,
  type ErrorEnvelope,
  type EventJson,
  type PageJson,
  type SessionJson,
} from "./helpers";

beforeAll(applyMigrations);

const TEXT_MESSAGE = { type: "user.message", content: [{ type: "text", text: "hello" }] };

/** SSE 读取器:跨调用共享解码缓冲与单个 pending read(流只允许一个未决读) */
interface StreamReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | null;
  buffer: string;
}

function openStreamReader(res: Response): StreamReader {
  return { reader: res.body!.getReader(), pending: null, buffer: "" };
}

/**
 * 读取一帧(以空行分隔);超时返回 null 且保留 pending read 供下次复用。
 * 收尾前必须把 pending 读净——带 pending 的 cancel 会触发运行时内部拒绝,
 * 在测试基线里表现为 unhandled rejection。
 */
async function readFrame(s: StreamReader, timeoutMs = 5000): Promise<string | null> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let index = s.buffer.indexOf("\n\n");
    if (index !== -1) {
      const frame = s.buffer.slice(0, index);
      s.buffer = s.buffer.slice(index + 2);
      return frame;
    }
    if (Date.now() > deadline) return null;
    if (s.pending === null) s.pending = s.reader.read();
    const winner = await Promise.race([
      s.pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
    ]);
    if (winner === null) continue;
    s.pending = null;
    if (winner.done) return null;
    s.buffer += decoder.decode(winner.value, { stream: true });
  }
}

/** 干净收尾:调用方已读净 pending;防御性吞掉可能的残留拒绝 */
async function closeStreamReader(s: StreamReader): Promise<void> {
  if (s.pending !== null) s.pending.catch(() => undefined);
  await s.reader.cancel();
}

function parseDataFrames(frames: string[]): EventJson[] {
  return frames
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as EventJson);
}

async function eventTypes(sessionId: string): Promise<string[]> {
  const page = await jsonBody<PageJson<EventJson>>(await listEvents(sessionId));
  return page.data.map((event) => event.type);
}

describe("POST /v1/sessions/{id}/events — 发送事件与 null-turn 生命周期", () => {
  it("user.message 返回持久化事件(null-turn 异步完成 status_running → usage → status_idle)", async () => {
    const session = await createDefaultSession();
    const res = await sendEvents(session.id, [TEXT_MESSAGE]);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: EventJson[] }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toMatch(/^sevt_/);
    expect(body.data[0]!.type).toBe("user.message");
    expect(body.data[0]!.processed_at).toBeNull();
    expect(body.data[0]!.content).toEqual([{ type: "text", text: "hello" }]);

    // null-turn fire-and-forget:轮询直到终局事件出现
    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "session.usage",
      "session.status_idle",
    ]);

    const idle = events.find((event) => event.type === "session.status_idle")!;
    expect(idle.stop_reason).toEqual({ type: "end_turn" });
    const usage = events.find((event) => event.type === "session.usage")!;
    expect(usage).toMatchObject({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    // 输入消费后 processed_at 回填(runtime.md §2.1 的唯一可变字段)
    expect(events.find((event) => event.type === "user.message")!.processed_at).not.toBeNull();

    // 会话回到 idle(D1 投影回写)
    const after = await jsonBody<SessionJson>(await getSession(session.id));
    expect(after.status).toBe("idle");
  });

  it("一次请求多条消息按序落库且都被消费", async () => {
    const session = await createDefaultSession();
    const res = await sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "first" }] },
      { type: "user.message", content: [{ type: "text", text: "second" }] },
    ]);
    expect(res.status).toBe(200);
    expect((await jsonBody<{ data: EventJson[] }>(res)).data).toHaveLength(2);

    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "user.message",
      "session.status_running",
      "session.usage",
      "session.status_idle",
    ]);
    expect(events.every((event) => event.type !== "user.message" || event.processed_at !== null)).toBe(
      true,
    );
  });

  it("user.interrupt 单独发送不触发 turn", async () => {
    const session = await createDefaultSession();
    const res = await sendEvents(session.id, [{ type: "user.interrupt" }]);
    expect(res.status).toBe(200);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "user.interrupt"));
    const types = await eventTypes(session.id);
    expect(types).toEqual(["user.interrupt"]);
    expect(types).not.toContain("session.status_running");
  });

  it("user.tool_confirmation 无待审批项返回 400(M3 挂起语义就位前的行为)", async () => {
    const session = await createDefaultSession();
    const res = await sendEvents(session.id, [
      { type: "user.tool_confirmation", tool_use_id: "sevt_tool_01J", result: "allow" },
    ]);
    expect(res.status).toBe(400);
    const error = (await jsonBody<ErrorEnvelope>(res)).error;
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("No pending tool confirmation");
  });

  it("请求校验:空 events / 11 条 / 未知事件类型 / 非法 content 均 400;不带凭证 401", async () => {
    const session = await createDefaultSession();
    expect((await sendEvents(session.id, { events: [] })).status).toBe(400);
    expect(
      (await sendEvents(session.id, { events: Array.from({ length: 11 }, () => TEXT_MESSAGE) })).status,
    ).toBe(400);
    expect((await sendEvents(session.id, [{ type: "user.define_outcome" }])).status).toBe(400);
    expect((await sendEvents(session.id, [{ type: "user.message", content: [] }])).status).toBe(400);
    expect(
      (await exports.default.fetch(`http://example.com/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ events: [TEXT_MESSAGE] }),
      })).status,
    ).toBe(401);
  });

  it("不存在与会话 404;已归档会话拒绝新事件 409", async () => {
    expect((await sendEvents("sess_01911111-9999-7999-8999-999999999999", [TEXT_MESSAGE])).status).toBe(404);
    const session = await createDefaultSession();
    await archiveSessionInDb(session.id);
    expect((await sendEvents(session.id, [TEXT_MESSAGE])).status).toBe(409);
  });
});

describe("GET /v1/sessions/{id}/events — 事件历史检索", () => {
  it("types 过滤(重复参数与逗号分隔)、order=desc、游标分页", async () => {
    const session = await createDefaultSession();
    await sendEvents(session.id, [TEXT_MESSAGE]);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "session.status_idle"));

    const filtered = await jsonBody<PageJson<EventJson>>(
      await listEvents(session.id, "?types[]=session.status_idle&types[]=session.usage"),
    );
    expect(filtered.data.every((event) => event.type.startsWith("session."))).toBe(true);
    expect(filtered.data.map((event) => event.type)).toEqual(["session.usage", "session.status_idle"]);

    const comma = await jsonBody<PageJson<EventJson>>(
      await listEvents(session.id, "?types=session.status_idle"),
    );
    expect(comma.data).toHaveLength(1);

    const desc = await jsonBody<PageJson<EventJson>>(await listEvents(session.id, "?order=desc"));
    expect(desc.data[0]!.type).toBe("session.status_idle");

    const firstPage = await jsonBody<PageJson<EventJson>>(await listEvents(session.id, "?limit=2"));
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.next_page).not.toBeNull();
    const secondPage = await jsonBody<PageJson<EventJson>>(
      await listEvents(session.id, `?limit=2&page=${encodeURIComponent(firstPage.next_page!)}`),
    );
    expect(secondPage.data).toHaveLength(2);
    expect([...firstPage.data, ...secondPage.data].map((event) => event.type)).toEqual(
      await eventTypes(session.id),
    );
  });

  it("非法参数:未知 type / 非法 created_at / 篡改游标 / 不存在的会话", async () => {
    const session = await createDefaultSession();
    expect((await listEvents(session.id, "?types[]=nope")).status).toBe(400);
    expect((await listEvents(session.id, "?created_at[gte]=yesterday")).status).toBe(400);
    expect((await listEvents(session.id, "?page=not-a-cursor")).status).toBe(400);
    expect((await listEvents("sess_01911111-9999-7999-8999-999999999999")).status).toBe(404);
  });

  it("created_at[gte] 边界过滤生效", async () => {
    const session = await createDefaultSession();
    await sendEvents(session.id, [TEXT_MESSAGE]);
    const events = await pollForEvent(
      session.id,
      (list) => list.some((event) => event.type === "session.status_idle"),
    );
    const firstAt = events[0]!.created_at;
    const afterAll = await jsonBody<PageJson<EventJson>>(
      await listEvents(session.id, `?created_at[gt]=${encodeURIComponent(firstAt)}`),
    );
    expect(afterAll.data.some((event) => event.id === events[0]!.id)).toBe(false);
  });
});

describe("GET /v1/sessions/{id}/events/stream — SSE 订阅", () => {
  it("只推连接后的新事件:先收 ping,发送后按序收到 user.message → status_running → usage → status_idle", async () => {
    const session = await createDefaultSession();
    const stream = await openEventStream(session.id);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const s = openStreamReader(stream);
    // 订阅建立帧(注释帧,不携带事件语义)
    expect(await readFrame(s)).toBe(": ping");

    await sendEvents(session.id, [TEXT_MESSAGE]);
    const expected = [
      "user.message",
      "session.status_running",
      "session.usage",
      "session.status_idle",
    ];
    for (const type of expected) {
      const frame = await readFrame(s);
      expect(frame).toMatch(/^data: \{/);
      expect(parseDataFrames([frame!])[0]!.type).toBe(type);
    }
    await closeStreamReader(s);
  });

  it("连接前已存在的事件不被回放(重连协议 = 列表补历史 + 按 id 去重)", async () => {
    const session = await createDefaultSession();
    await sendEvents(session.id, [TEXT_MESSAGE]);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "session.status_idle"));

    const stream = await openEventStream(session.id);
    const s = openStreamReader(stream);
    expect(await readFrame(s)).toBe(": ping");
    // 观察窗:心跳间隔 15s,短窗口内不应有任何数据帧
    expect(await readFrame(s, 800)).toBeNull();
    // 用一帧良性事件(user.interrupt 不触发 turn)把 pending read 冲净,再干净取消
    await sendEvents(session.id, [{ type: "user.interrupt" }]);
    const flush = await readFrame(s);
    expect(parseDataFrames([flush!])[0]!.type).toBe("user.interrupt");
    await closeStreamReader(s);
  });

  it("event_deltas[] 非法值 400;不存在的会话 404;不带凭证 401", async () => {
    const session = await createDefaultSession();
    expect((await openEventStream(session.id, "?event_deltas[]=agent.message&event_deltas[]=bogus")).status).toBe(400);
    expect((await openEventStream("sess_01911111-9999-7999-8999-999999999999")).status).toBe(404);
    expect(
      (
        await exports.default.fetch(`http://example.com/v1/sessions/${session.id}/events/stream`, {
          headers: { Authorization: `Bearer ${API_KEY.slice(0, -1)}` },
        })
      ).status,
    ).toBe(401);
  });
});

describe("控制面与运行时的联动", () => {
  it("更新配置实际变更时外发 session.updated;无变化更新不外发", async () => {
    const session = await createDefaultSession();
    await updateSession(session.id, { title: "renamed" });
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "session.updated"));

    const unchangedAt = (await eventTypes(session.id)).length;
    await updateSession(session.id, { title: "renamed" });
    // 无变化更新不写库也不追加事件;给一个短窗口确认事件数不变
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await eventTypes(session.id)).length).toBe(unchangedAt);
  });

  it("删除会话后 DO 事件存储被清空", async () => {
    const session = await createDefaultSession();
    await sendEvents(session.id, [TEXT_MESSAGE]);
    await pollForEvent(session.id, (list) => list.some((event) => event.type === "session.status_idle"));

    expect((await deleteSessionViaApi(session.id)).status).toBe(200);

    // 删除联动是 waitUntil 异步清理:轮询 DO 直到存储清空
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.id));
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = await stub.listEvents({ filters: {}, limit: 100, order: "asc" });
      if (result.data.length === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`session storage not wiped; events: ${JSON.stringify(result.data)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
});
