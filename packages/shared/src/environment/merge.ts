/**
 * 更新语义的纯函数实现(docs/environment/api/update-environment.md 的"更新语义"一节):
 * - 省略的字段保持不变
 * - 标量字段(name/description)整体替换;description 可传 null 清空
 * - config 整体替换(非深合并);null 恢复默认 cloud 配置,替换值先经 normalize 归一化
 * - metadata 按键合并:新键新增、旧键覆盖、值为 null 的键删除
 * - scope 只接受 organization,null 或省略不改变(单租户恒为 organization,无需合并)
 * 替换进来的 config 是输入形态,先经 normalize 归一化再合并,
 * 保证合并结果与当前落库形态同为归一化形态,可直接做无变化比较。
 */

import type { NormalizedEnvironmentRecord } from './normalize';
import { normalizeEnvironmentConfig } from './normalize';
import type { EnvironmentUpdateRequestInput } from './schemas';

/** 把补丁合并进当前记录,返回新的归一化记录 */
export function mergeEnvironmentRecord(
  current: NormalizedEnvironmentRecord,
  patch: EnvironmentUpdateRequestInput,
): NormalizedEnvironmentRecord {
  return {
    name: patch.name ?? current.name,
    description:
      patch.description === undefined ? current.description : (patch.description ?? null),
    config:
      patch.config === undefined
        ? current.config
        : patch.config === null
          ? normalizeEnvironmentConfig(null)
          : normalizeEnvironmentConfig(patch.config),
    metadata: mergeMetadata(current.metadata, patch.metadata),
  };
}

/** metadata 整个字段省略或传 null 时保持不变;按键合并,null 删键 */
function mergeMetadata(
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
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      key in b &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * 无变化检测:合并结果与当前落库形态逐字段一致则为真。
 * 上层据此跳过写库,直接返回现状(updated_at 保持不变)。
 */
export function environmentRecordEquals(
  a: NormalizedEnvironmentRecord,
  b: NormalizedEnvironmentRecord,
): boolean {
  return deepEqual(a, b);
}
