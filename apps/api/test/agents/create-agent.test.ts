import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, jsonBody, postAgent, type AgentJson, type ErrorEnvelope } from "./helpers";
import { createDefaultSkill } from "../skills/helpers";

beforeAll(applyMigrations);

const docExample = {
  name: "Coding Assistant",
  model: "glm-5.3",
  system: "You are a helpful coding agent.",
  tools: [{ type: "agent_toolset_20260601" }],
};

describe("POST /v1/agents 成功路径", () => {
  it("文档示例创建成功,响应回显归一化后的完整配置", async () => {
    const res = await postAgent(docExample);
    expect(res.status).toBe(201);
    const body = await jsonBody<AgentJson>(res);
    expect(body.id).toMatch(/^agent_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.type).toBe("agent");
    expect(body.name).toBe("Coding Assistant");
    expect(body.model).toEqual({ id: "glm-5.3", effort: "max", speed: "standard" });
    expect(body.system).toBe("You are a helpful coding agent.");
    expect(body.description).toBeNull();
    expect(body.tools).toEqual([
      {
        type: "agent_toolset_20260601",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [],
      },
    ]);
    expect(body.skills).toEqual([]);
    expect(body.mcp_servers).toEqual([]);
    expect(body.metadata).toEqual({});
    expect(body.multiagent).toBeNull();
    expect(body.version).toBe(1);
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.updated_at).toBe(body.created_at);
    expect(body.archived_at).toBeNull();
  });

  it("glm-5.3-flash 的默认 effort 为 high", async () => {
    const res = await postAgent({ name: "flash", model: "glm-5.3-flash" });
    expect(res.status).toBe(201);
    expect((await jsonBody<AgentJson>(res)).model).toEqual({
      id: "glm-5.3-flash",
      effort: "high",
      speed: "standard",
    });
  });

  it("全特性配置(内置工具集 + MCP + 自定义工具 + skills)成功并正确回显", async () => {
    // skills 引用必须可解析(M8 联动规则):先建真实 Skill 再引用
    const skill = await createDefaultSkill();
    const res = await postAgent({
      name: "full",
      model: { id: "glm-5.3", effort: "low" },
      description: "全特性示例",
      tools: [
        {
          type: "agent_toolset_20260601",
          default_config: { enabled: false, permission_policy: { type: "always_ask" } },
          configs: [{ name: "bash", enabled: true }],
        },
        { type: "mcp_toolset", mcp_server_name: "kb", configs: [{ name: "search" }] },
        {
          type: "custom",
          name: "lookup_order",
          description: "查询订单",
          input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
      skills: [{ type: "custom", skill_id: skill.id, version: "1" }],
      mcp_servers: [{ type: "url", name: "kb", url: "https://mcp.example.com/mcp" }],
      metadata: { team: "infra" },
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<AgentJson>(res);
    expect(body.model.effort).toBe("low");
    expect(body.tools).toEqual([
      {
        type: "agent_toolset_20260601",
        default_config: { enabled: false, permission_policy: { type: "always_ask" } },
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "kb",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [{ name: "search", enabled: true, permission_policy: { type: "always_allow" } }],
      },
      {
        type: "custom",
        name: "lookup_order",
        description: "查询订单",
        input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
    expect(body.skills).toEqual([{ type: "custom", skill_id: skill.id, version: "1" }]);
    expect(body.mcp_servers).toEqual([{ type: "url", name: "kb", url: "https://mcp.example.com/mcp" }]);
    expect(body.metadata).toEqual({ team: "infra" });
  });
});

describe("POST /v1/agents 校验失败返回 400", () => {
  async function expectInvalid(body: unknown, hint?: string) {
    const res = await postAgent(body);
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.type).toBe("error");
    expect(envelope.error.type).toBe("invalid_request_error");
    if (hint) {
      const issues = JSON.stringify(envelope.error.details?.issues ?? []);
      expect(issues).toContain(hint);
    }
    return envelope;
  }

  it("缺 name", async () => {
    await expectInvalid({ model: "glm-5.3" });
  });

  it("model 非法", async () => {
    await expectInvalid({ name: "a", model: "gpt-4" }, "model");
  });

  it("name 超过 256 字符", async () => {
    await expectInvalid({ ...docExample, name: "a".repeat(257) });
  });

  it("system 超过 100000 字符", async () => {
    await expectInvalid({ ...docExample, system: "a".repeat(100001) });
  });

  it("metadata 超过 16 键", async () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    await expectInvalid({ ...docExample, metadata });
  });

  it("mcp_toolset 引用不存在的 server", async () => {
    await expectInvalid(
      { ...docExample, tools: [{ type: "mcp_toolset", mcp_server_name: "kb" }] },
      "unknown mcp_server_name",
    );
  });

  it("配置 skills 但没有 agent_toolset_20260601", async () => {
    await expectInvalid(
      { ...docExample, tools: [], skills: [{ type: "zai", skill_id: "s", version: "1" }] },
      "agent_toolset_20260601",
    );
  });

  it("未知顶层字段被拒绝", async () => {
    await expectInvalid({ ...docExample, extra: true });
  });

  it("请求体不是合法 JSON", async () => {
    const res = await postAgent("{not json");
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("invalid_request_error");
  });
});

describe("POST /v1/agents 认证", () => {
  it("不带凭证返回 401 错误信封", async () => {
    const res = await exports.default.fetch("http://example.com/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(docExample),
    });
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("authentication_error");
    expect(envelope.request_id).toMatch(/^req_/);
  });
});
