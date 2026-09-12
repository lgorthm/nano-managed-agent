import { describe, expect, it } from "vitest";
import { AgentCreateRequestSchema, AgentWithOverridesInputSchema, normalizeAgentConfig } from "../../src";
import type { NormalizedAgentConfig } from "../../src";
import { resolveSessionAgent, toSessionAgentConfig } from "../../src/session/resolve";
import type { SessionAgentOverrides } from "../../src/session/resolve";

/** 走完整链路构造归一化的版本配置(会话创建时的基准形态) */
function versionConfig(body: Record<string, unknown> = {}): NormalizedAgentConfig {
  return normalizeAgentConfig(
    AgentCreateRequestSchema.parse({ name: "base", model: "glm-5.3", ...body }),
  );
}

/** 覆盖对象走 AgentWithOverridesInput 解析(与线上路径一致,含 configs 等默认值) */
function overridesOf(body: Record<string, unknown>): SessionAgentOverrides {
  const parsed = AgentWithOverridesInputSchema.parse({
    type: "agent_with_overrides",
    id: "agent_01911111-1111-7111-8111-111111111111",
    ...body,
  });
  const { type: _type, id: _id, version: _version, ...overrides } = parsed;
  return overrides;
}

describe("toSessionAgentConfig", () => {
  it("去掉 metadata,其余字段原样保留", () => {
    const config = versionConfig({ system: "s", metadata: { k: "v" } });
    const snapshot = toSessionAgentConfig(config);
    expect(snapshot).toEqual({
      name: "base",
      model: { id: "glm-5.3", effort: "max", speed: "standard" },
      system: "s",
      description: null,
      tools: [],
      skills: [],
      mcp_servers: [],
    });
    expect("metadata" in snapshot).toBe(false);
  });
});

describe("resolveSessionAgent 覆盖语义", () => {
  it("无覆盖:原样返回基准", () => {
    const base = toSessionAgentConfig(versionConfig({ system: "keep" }));
    expect(resolveSessionAgent(base)).toBe(base);
    expect(resolveSessionAgent(base, {})).toEqual(base);
  });

  it("model 字符串简写按新模型补全默认档位", () => {
    const base = toSessionAgentConfig(versionConfig());
    const resolved = resolveSessionAgent(base, overridesOf({ model: "glm-5.3-flash" }));
    expect(resolved.model).toEqual({ id: "glm-5.3-flash", effort: "high", speed: "standard" });
  });

  it("model 对象形态保留显式 effort", () => {
    const base = toSessionAgentConfig(versionConfig());
    const resolved = resolveSessionAgent(base, overridesOf({ model: { id: "glm-5.3", effort: "low" } }));
    expect(resolved.model.effort).toBe("low");
  });

  it("system 覆盖为具体值;传 null 清空;省略继承", () => {
    const base = toSessionAgentConfig(versionConfig({ system: "base system" }));
    expect(resolveSessionAgent(base, overridesOf({ system: "override" })).system).toBe("override");
    expect(resolveSessionAgent(base, overridesOf({ system: null })).system).toBeNull();
    expect(resolveSessionAgent(base, overridesOf({})).system).toBe("base system");
  });

  it("tools 整体替换并归一化(default_config 补全);null 与空数组等价清空", () => {
    const base = toSessionAgentConfig(
      versionConfig({ tools: [{ type: "agent_toolset_20260601", default_config: { enabled: false } }] }),
    );
    const replaced = resolveSessionAgent(base, overridesOf({ tools: [{ type: "agent_toolset_20260601" }] }));
    expect(replaced.tools).toEqual([
      {
        type: "agent_toolset_20260601",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [],
      },
    ]);
    expect(resolveSessionAgent(base, overridesOf({ tools: null })).tools).toEqual([]);
    expect(resolveSessionAgent(base, overridesOf({ tools: [] })).tools).toEqual([]);
  });

  it("skills 与 mcp_servers 整体替换;null 清空;省略继承", () => {
    const skill = { type: "custom", skill_id: "skill_x", version: "3" };
    const base = toSessionAgentConfig(
      versionConfig({ skills: [skill], tools: [{ type: "agent_toolset_20260601" }] }),
    );
    expect(resolveSessionAgent(base, overridesOf({ skills: null })).skills).toEqual([]);
    expect(resolveSessionAgent(base, overridesOf({ skills: [] })).skills).toEqual([]);
    expect(resolveSessionAgent(base, overridesOf({})).skills).toEqual([skill]);
    const server = { type: "url", name: "kb", url: "https://mcp.example.com/mcp" };
    expect(resolveSessionAgent(base, overridesOf({ mcp_servers: [server] })).mcp_servers).toEqual([server]);
  });

  it("name 与 description 永远继承基准(不可覆盖)", () => {
    const base = toSessionAgentConfig(versionConfig({ description: "base desc" }));
    const resolved = resolveSessionAgent(base, overridesOf({ system: "x" }));
    expect(resolved.name).toBe("base");
    expect(resolved.description).toBe("base desc");
  });

  it("逐字段独立:只覆盖 tools 时 model/system/skills 保持基准", () => {
    const base = toSessionAgentConfig(versionConfig({ system: "keep" }));
    const resolved = resolveSessionAgent(base, overridesOf({ tools: [{ type: "agent_toolset_20260601" }] }));
    expect(resolved.system).toBe("keep");
    expect(resolved.model).toEqual(base.model);
    expect(resolved.skills).toEqual([]);
  });
});
