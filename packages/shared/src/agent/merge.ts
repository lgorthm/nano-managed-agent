/**
 * 更新语义的纯函数实现(docs/agent/api/update-agent.md 的"更新语义"一节):
 * - 省略的字段保持不变
 * - 标量字段(model/system/name/description)整体替换;system 与 description 可传 null 清空
 * - 数组字段(tools/mcp_servers/skills)整体替换;null 与空数组等价,均表示清空
 * - metadata 按键合并:新键新增、旧键覆盖、值为 null 的键删除
 * 替换进来的 model 与 tools 是输入形态,先经 normalize 归一化再合并,
 * 保证合并结果与当前版本同为归一化形态,可直接做无变化比较。
 */
import type { AgentUpdateRequestInput } from "./schemas";
import type { NormalizedAgentConfig } from "./normalize";
import { normalizeModel, normalizeToolset } from "./normalize";

/** 把补丁合并进当前配置,返回新的归一化配置 */
export function mergeAgentConfig(
  current: NormalizedAgentConfig,
  patch: AgentUpdateRequestInput,
): NormalizedAgentConfig {
  return {
    name: patch.name ?? current.name,
    model: patch.model === undefined ? current.model : normalizeModel(patch.model),
    system: patch.system === undefined ? current.system : patch.system ?? null,
    description: patch.description === undefined ? current.description : patch.description ?? null,
    tools:
      patch.tools === undefined
        ? current.tools
        : patch.tools === null
          ? []
          : patch.tools.map(normalizeToolset),
    skills: patch.skills === undefined ? current.skills : patch.skills ?? [],
    mcp_servers:
      patch.mcp_servers === undefined ? current.mcp_servers : patch.mcp_servers ?? [],
    metadata: mergeMetadata(current.metadata, patch.metadata),
  };
}

/** metadata 整个字段省略或传 null 时保持不变;按键合并,null 删键 */
export function mergeMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null | undefined,
): Record<string, string> {
  if (patch === null || patch === undefined) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** 语义化深度相等:键序无关,数组按序比较 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => key in b && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * 无变化检测:合并结果与当前版本逐字段一致则为真。
 * 上层据此跳过写库,直接返回现有版本(version 与时间戳保持不变)。
 */
export function agentConfigEquals(a: NormalizedAgentConfig, b: NormalizedAgentConfig): boolean {
  return deepEqual(a, b);
}
