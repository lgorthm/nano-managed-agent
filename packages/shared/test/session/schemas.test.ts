import { describe, expect, it } from "vitest";
import { SessionCreateRequestSchema, SessionUpdateRequestSchema } from "../../src";

const AGENT_ID = "agent_01911111-1111-7111-8111-111111111111";
const ENV_ID = "env_01911111-2222-7222-8222-222222222222";
const FILE_ID = "file_01911111-5555-7555-8555-555555555555";

/** 创建请求的合法最小形态 */
function createRequest(body: Record<string, unknown>) {
  return SessionCreateRequestSchema.parse({ agent: AGENT_ID, environment_id: ENV_ID, ...body });
}

describe("SessionCreateRequestSchema agent 三形态与 anyOf", () => {
  it("agent 字符串形态通过", () => {
    expect(createRequest({}).agent).toBe(AGENT_ID);
  });

  it("兼容字段 agent_id 单独出现通过", () => {
    const parsed = SessionCreateRequestSchema.parse({ agent_id: AGENT_ID, environment_id: ENV_ID });
    expect(parsed.agent_id).toBe(AGENT_ID);
  });

  it("agent 与 agent_id 均缺失拒绝", () => {
    const result = SessionCreateRequestSchema.safeParse({ environment_id: ENV_ID });
    expect(result.success).toBe(false);
  });

  it("agent 引用对象钉版本通过,version 缺省为 undefined", () => {
    const parsed = createRequest({ agent: { type: "agent", id: AGENT_ID, version: 3 } });
    expect(parsed.agent).toEqual({ type: "agent", id: AGENT_ID, version: 3 });
    expect(createRequest({ agent: { type: "agent", id: AGENT_ID } }).agent).toEqual({
      type: "agent",
      id: AGENT_ID,
    });
  });

  it("agent_with_overrides 形态通过并保留覆盖字段", () => {
    const parsed = createRequest({
      agent: {
        type: "agent_with_overrides",
        id: AGENT_ID,
        system: "reviewer mode",
        tools: [{ type: "agent_toolset_20260601" }],
      },
    });
    expect(parsed.agent).toEqual({
      type: "agent_with_overrides",
      id: AGENT_ID,
      system: "reviewer mode",
      tools: [{ type: "agent_toolset_20260601", configs: [] }],
    });
  });

  it("version 非正整数拒绝", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        agent: { type: "agent", id: AGENT_ID, version: 0 },
        environment_id: ENV_ID,
      }).success,
    ).toBe(false);
  });
});

describe("SessionCreateRequestSchema 字段约束与一期裁剪", () => {
  it("environment_id 形态校验:非 env_ UUID 拒绝", () => {
    expect(
      SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: "sess_wrong" }).success,
    ).toBe(false);
    expect(
      SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: "ENV_" + "0".repeat(36) }).success,
    ).toBe(false);
  });

  it("title 超 256 拒绝;null 通过", () => {
    expect(SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: ENV_ID, title: "x".repeat(257) }).success).toBe(false);
    expect(createRequest({ title: null }).title).toBeNull();
  });

  it("metadata 超 16 键拒绝", () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    expect(
      SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: ENV_ID, metadata }).success,
    ).toBe(false);
  });

  it("initial_events 非空拒绝(一期裁剪),空数组与省略通过", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        agent: AGENT_ID,
        environment_id: ENV_ID,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
      }).success,
    ).toBe(false);
    expect(createRequest({ initial_events: [] }).initial_events).toEqual([]);
  });

  it("vault_ids 非空拒绝(一期裁剪)", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        agent: AGENT_ID,
        environment_id: ENV_ID,
        vault_ids: ["vault_1"],
      }).success,
    ).toBe(false);
    expect(createRequest({ vault_ids: [] }).vault_ids).toEqual([]);
  });

  it("resources 仅接受 type: file", () => {
    expect(createRequest({ resources: [{ type: "file", file_id: FILE_ID }] }).resources).toEqual([
      { type: "file", file_id: FILE_ID },
    ]);
    expect(
      SessionCreateRequestSchema.safeParse({
        agent: AGENT_ID,
        environment_id: ENV_ID,
        resources: [{ type: "memory_store", memory_store_id: "ms_1" }],
      }).success,
    ).toBe(false);
  });

  it("resources 超 508 拒绝;超 500 file 拒绝", () => {
    const many = Array.from({ length: 509 }, () => ({ type: "file", file_id: FILE_ID }));
    expect(
      SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: ENV_ID, resources: many }).success,
    ).toBe(false);
    const fiveHundredAndOne = Array.from({ length: 501 }, () => ({ type: "file", file_id: FILE_ID }));
    expect(
      SessionCreateRequestSchema.safeParse({
        agent: AGENT_ID,
        environment_id: ENV_ID,
        resources: fiveHundredAndOne,
      }).success,
    ).toBe(false);
  });

  it("未知键拒绝(strict):提交冻结字段直接 400", () => {
    for (const frozen of ["model", "system", "skills", "vaults"]) {
      expect(
        SessionCreateRequestSchema.safeParse({ agent: AGENT_ID, environment_id: ENV_ID, [frozen]: 1 }).success,
      ).toBe(false);
    }
  });

  it("defaults:title/metadata/initial_events/resources/vault_ids 的空态", () => {
    const parsed = createRequest({});
    expect(parsed.title).toBeUndefined();
    expect(parsed.metadata).toEqual({});
    expect(parsed.initial_events).toEqual([]);
    expect(parsed.resources).toEqual([]);
    expect(parsed.vault_ids).toEqual([]);
  });
});

describe("SessionUpdateRequestSchema", () => {
  it("空对象拒绝(minProperties: 1)", () => {
    expect(SessionUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("title / metadata / agent.tools 各自单独成立", () => {
    expect(SessionUpdateRequestSchema.safeParse({ title: "t" }).success).toBe(true);
    expect(SessionUpdateRequestSchema.safeParse({ metadata: { k: "v" } }).success).toBe(true);
    expect(
      SessionUpdateRequestSchema.safeParse({ agent: { tools: [{ type: "agent_toolset_20260601" }] } }).success,
    ).toBe(true);
  });

  it("agent 空对象拒绝(至少 tools 或 mcp_servers)", () => {
    expect(SessionUpdateRequestSchema.safeParse({ agent: {} }).success).toBe(false);
  });

  it("冻结字段出现即拒绝", () => {
    for (const body of [
      { model: "glm-5.3" },
      { system: "x" },
      { skills: [] },
      { vault_ids: [] },
      { environment_id: ENV_ID },
      { resources: [] },
      { initial_events: [] },
    ]) {
      expect(SessionUpdateRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("mcp_servers 不得脱离 tools 单独提交", () => {
    expect(
      SessionUpdateRequestSchema.safeParse({
        agent: { mcp_servers: [{ type: "url", name: "kb", url: "https://mcp.example.com/mcp" }] },
      }).success,
    ).toBe(false);
  });

  it("tools 含 mcp_toolset 时必须同请求提交 mcp_servers", () => {
    expect(
      SessionUpdateRequestSchema.safeParse({
        agent: { tools: [{ type: "mcp_toolset", mcp_server_name: "kb" }] },
      }).success,
    ).toBe(false);
    expect(
      SessionUpdateRequestSchema.safeParse({
        agent: {
          tools: [{ type: "mcp_toolset", mcp_server_name: "kb" }],
          mcp_servers: [{ type: "url", name: "kb", url: "https://mcp.example.com/mcp" }],
        },
      }).success,
    ).toBe(true);
  });

  it("title 传 null 与 metadata 传 null 都是合法补丁(清空/不变)", () => {
    expect(SessionUpdateRequestSchema.safeParse({ title: null }).success).toBe(true);
    expect(SessionUpdateRequestSchema.safeParse({ metadata: null }).success).toBe(true);
  });
});
