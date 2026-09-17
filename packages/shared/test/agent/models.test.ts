import { describe, expect, it } from 'vitest';
import {
  catalogEntryToListEntry,
  defaultModelEffort,
  findModelEntry,
  MODEL_CATALOG,
  mergeModelEntries,
  resolveWireModel,
} from '../../src';

describe('模型目录', () => {
  it('静态目录:GLM 模型 id 不变,wire 侧映射到 @cf/zai-org', () => {
    expect(MODEL_CATALOG.map((entry) => [entry.id, entry.wireModel])).toEqual([
      ['glm-5.3', '@cf/zai-org/glm-5.3'],
      ['glm-5.3-flash', '@cf/zai-org/glm-5.3-flash'],
    ]);
  });

  it('findModelEntry 命中与未命中', () => {
    expect(findModelEntry('glm-5.3')?.wireModel).toBe('@cf/zai-org/glm-5.3');
    expect(findModelEntry('@cf/zai-org/glm-5.2')).toBeUndefined();
  });

  it('resolveWireModel:目录内映射,目录外原样透传', () => {
    expect(resolveWireModel('glm-5.3-flash')).toBe('@cf/zai-org/glm-5.3-flash');
    expect(resolveWireModel('@cf/zai-org/glm-5.2')).toBe('@cf/zai-org/glm-5.2');
    expect(resolveWireModel('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });

  it('defaultModelEffort:目录内按条目,目录外取 high', () => {
    expect(defaultModelEffort('glm-5.3')).toBe('max');
    expect(defaultModelEffort('glm-5.3-flash')).toBe('high');
    expect(defaultModelEffort('@cf/zai-org/glm-5.2')).toBe('high');
  });
});

describe('mergeModelEntries(静态目录 + 动态合并)', () => {
  const staticEntries = MODEL_CATALOG.map(catalogEntryToListEntry);

  it('动态条目追加,静态目录已映射的 wire 名称去重', () => {
    const merged = mergeModelEntries(staticEntries, [
      '@cf/zai-org/glm-5.2',
      '@cf/zai-org/glm-5.3', // 已由 glm-5.3 条目覆盖,不重复
    ]);
    expect(merged.map((entry) => entry.id)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      '@cf/zai-org/glm-5.2',
    ]);
  });

  it('动态条目的 source 按 @cf 前缀归类,id 即 wire 名', () => {
    const merged = mergeModelEntries(staticEntries, ['openai/gpt-4.1']);
    expect(merged[merged.length - 1]).toEqual({
      id: 'openai/gpt-4.1',
      label: 'openai/gpt-4.1',
      wire_model: 'openai/gpt-4.1',
      source: 'third-party',
      default_effort: 'high',
    });
  });

  it('空动态列表原样返回静态目录', () => {
    expect(mergeModelEntries(staticEntries, [])).toEqual(staticEntries);
  });
});
