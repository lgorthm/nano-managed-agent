import { describe, expect, it } from "vitest";
import type { NormalizedAgentConfig } from "../../src";
import { AgentCreateRequestSchema, AgentUpdateRequestSchema, normalizeAgentConfig } from "../../src";
import { agentConfigEquals, mergeAgentConfig } from "../../src/agent/merge";

/** 走完整链路构造归一化的当前配置 */
function currentConfig(body: Record<string, unknown> = {}): NormalizedAgentConfig {
  return normalizeAgentConfig(
    AgentCreateRequestSchema.parse({ name: "cur", model: "glm-5.3", ...body }),
  );
}

/** 走 schema 解析补丁,与线上路径一致 */
function patchOf(body: Record<string, unknown>) {
  return AgentUpdateRequestSchema.parse(body);
}

function merge(current: NormalizedAgentConfig, patchBody: Record<string, unknown>) {
  return mergeAgentConfig(current, patchOf(patchBody));
}

describe("mergeAgentConfig 标量字段", () => {
  it("空补丁:全部保持不变", () => {
    const current = currentConfig({ system: "s", description: "d" });
    expect(merge(current, {})).toEqual(current);
  });

  it("name 整体替换", () => {
    expect(merge(currentConfig(), { name: "new" }).name).toBe("new");
  });

  it("model 字符串简写按新模型补全默认档位", () => {
    expect(merge(currentConfig({ model: "glm-5.3" }), { model: "glm-5.3-flash" }).model).toEqual({
      id: "glm-5.3-flash",
      effort: "high",
      speed: "standard",
    });
  });

  it("model 对象形态保留显式 effort", () => {
    expect(merge(currentConfig(), { model: { id: "glm-5.3", effort: "low" } }).model.effort).toBe("low");
  });

  it("system 传 null 清空,省略保持", () => {
    const current = currentConfig({ system: "keep me" });
    expect(merge(current, { system: null }).system).toBeNull();
    expect(merge(current, {}).system).toBe("keep me");
    expect(merge(current, { system: "replaced" }).system).toBe("replaced");
  });

  it("description 传 null 清空,省略保持", () => {
    const current = currentConfig({ description: "d" });
    expect(merge(current, { description: null }).description).toBeNull();
    expect(merge(current, {}).description).toBe("d");
  });
});

describe("mergeAgentConfig 数组字段", () => {
  it("tools 传新值整体替换并归一化", () => {
    const current = currentConfig({ tools: [{ type: "agent_toolset_20260601" }] });
    const merged = merge(current, {
      tools: [
        {
          type: "agent_toolset_20260601",
          default_config: { enabled: false },
          configs: [{ name: "bash" }],
        },
      ],
    });
    expect(merged.tools).toEqual([
      {
        type: "agent_toolset_20260601",
        default_config: { enabled: false, permission_policy: { type: "always_allow" } },
        configs: [{ name: "bash", enabled: false, permission_policy: { type: "always_allow" } }],
      },
    ]);
  });

  it("tools 传 null 与空数组等价,均清空", () => {
    const current = currentConfig({ tools: [{ type: "agent_toolset_20260601" }] });
    expect(merge(current, { tools: null }).tools).toEqual([]);
    expect(merge(current, { tools: [] }).tools).toEqual([]);
  });

  it("skills 与 mcp_servers 同样整体替换、null 清空、省略保持", () => {
    const skill = { type: "zai" as const, skill_id: "s1", version: "1" };
    const server = { type: "url" as const, name: "kb", url: "https://mcp.example.com/mcp" };
    const current = currentConfig({
      tools: [{ type: "agent_toolset_20260601" }, { type: "mcp_toolset", mcp_server_name: "kb" }],
      skills: [skill],
      mcp_servers: [server],
    });
    const skill2 = { type: "zai" as const, skill_id: "s2", version: "2" };
    expect(merge(current, { skills: [skill2] }).skills).toEqual([skill2]);
    expect(merge(current, { skills: null }).skills).toEqual([]);
    expect(merge(current, {}).skills).toEqual([skill]);

    expect(merge(current, { mcp_servers: [] }).mcp_servers).toEqual([]);
    expect(merge(current, {}).mcp_servers).toEqual([server]);
  });
});

describe("mergeAgentConfig metadata 按键合并", () => {
  it("新键新增、旧键覆盖、null 删键、未提及键保留", () => {
    const current = currentConfig({ metadata: { a: "1", b: "2" } });
    expect(merge(current, { metadata: { b: "two", c: "3" } }).metadata).toEqual({ a: "1", b: "two", c: "3" });
    expect(merge(current, { metadata: { a: null } }).metadata).toEqual({ b: "2" });
    expect(merge(current, {}).metadata).toEqual({ a: "1", b: "2" });
    expect(merge(current, { metadata: null }).metadata).toEqual({ a: "1", b: "2" });
  });
});

describe("agentConfigEquals 无变化检测", () => {
  it("内容相同的不同对象为真(键序无关)", () => {
    const a = currentConfig({ system: "s", metadata: { x: "1", y: "2" } });
    const b = currentConfig({ metadata: { y: "2", x: "1" }, system: "s" });
    expect(agentConfigEquals(a, b)).toBe(true);
  });

  it("提交与当前一致的补丁,合并结果与当前相等", () => {
    const current = currentConfig({ system: "same" });
    expect(agentConfigEquals(merge(current, { system: "same" }), current)).toBe(true);
  });

  it("任一字段不同则为假", () => {
    const current = currentConfig({ system: "s" });
    expect(agentConfigEquals(merge(current, { system: "other" }), current)).toBe(false);
    expect(agentConfigEquals(merge(current, { name: "other" }), current)).toBe(false);
    expect(agentConfigEquals(merge(current, { model: "glm-5.3-flash" }), current)).toBe(false);
    expect(agentConfigEquals(merge(current, { system: null }), current)).toBe(false);
  });

  it("tools 内的顺序变化视为配置变化", () => {
    const custom = {
      type: "custom" as const,
      name: "t1",
      description: "d",
      input_schema: { type: "object" },
    };
    const custom2 = { ...custom, name: "t2" };
    const a = currentConfig({ tools: [custom, custom2] });
    const b = currentConfig({ tools: [custom2, custom] });
    expect(agentConfigEquals(a, b)).toBe(false);
  });

  it("metadata 键值变化为假", () => {
    expect(agentConfigEquals(currentConfig({ metadata: { k: "1" } }), currentConfig({ metadata: { k: "2" } }))).toBe(false);
  });
});
