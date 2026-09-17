import { describe, expect, it } from 'vitest';
import type { NormalizedAgentToolset } from '../../src/agent/normalize';
import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_INPUT_SCHEMAS,
  resolveBuiltinTools,
  validateToolInvocation,
} from '../../src/session/tools';

function toolset(overrides: Partial<NormalizedAgentToolset> = {}): NormalizedAgentToolset {
  return {
    type: 'agent_toolset_20260601',
    default_config: {
      enabled: true,
      permission_policy: { type: 'always_allow' },
    },
    configs: [],
    ...overrides,
  } as NormalizedAgentToolset;
}

describe('resolveBuiltinTools', () => {
  it('空 tools(无工具集)得到空表——模型调用不带 tools', () => {
    expect(resolveBuiltinTools([])).toEqual([]);
  });

  it('默认全启用 always_allow;configs 逐工具覆盖权限与启停', () => {
    const resolved = resolveBuiltinTools([
      toolset({
        configs: [
          {
            name: 'bash',
            enabled: true,
            permission_policy: { type: 'always_ask' },
          },
          {
            name: 'edit',
            enabled: false,
            permission_policy: { type: 'always_allow' },
          },
        ],
      }),
    ]);
    const byName = new Map(resolved.map((tool) => [tool.name, tool.permission]));
    expect(resolved).toHaveLength(6); // edit 被禁用
    expect(byName.get('bash')).toBe('always_ask');
    expect(byName.get('write')).toBe('always_allow');
    expect(byName.has('edit')).toBe(false);
  });

  it('default_config.enabled=false 时仅显式启用的工具可用', () => {
    const resolved = resolveBuiltinTools([
      toolset({
        default_config: {
          enabled: false,
          permission_policy: { type: 'always_allow' },
        },
        configs: [
          {
            name: 'bash',
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          {
            name: 'read',
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
        ],
      }),
    ]);
    expect(resolved.map((tool) => tool.name)).toEqual(['read', 'bash']);
  });
});

describe('内置工具定义与入参校验', () => {
  it('七个工具都有模型侧定义(function 形态)与 zod 入参校验', () => {
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'] as const) {
      expect(BUILTIN_TOOL_DEFINITIONS[name].function.name).toBe(name);
      expect(BUILTIN_TOOL_DEFINITIONS[name].function.parameters).toHaveProperty('properties');
      expect(BUILTIN_TOOL_INPUT_SCHEMAS[name]).toBeDefined();
    }
  });

  it('入参校验拒绝未知键与类型错误(模型生成物不可信)', () => {
    expect(BUILTIN_TOOL_INPUT_SCHEMAS.bash.safeParse({ command: 'ls', extra: 1 }).success).toBe(
      false,
    );
    expect(BUILTIN_TOOL_INPUT_SCHEMAS.bash.safeParse({ command: 42 }).success).toBe(false);
    expect(BUILTIN_TOOL_INPUT_SCHEMAS.bash.safeParse({ command: 'ls' }).success).toBe(true);
    expect(BUILTIN_TOOL_INPUT_SCHEMAS.edit.safeParse({ path: 'a', old_string: 'x' }).success).toBe(
      false,
    );
  });
});

describe('validateToolInvocation(执行前的协议级校验)', () => {
  it('未知工具与非法 JSON 入参(标记对象)被拒绝,合法入参通过', () => {
    expect(validateToolInvocation('nope', {})).toContain('Unknown tool');
    expect(validateToolInvocation('bash', { __invalid_json: '{broken' })).toContain(
      'Invalid arguments',
    );
    expect(validateToolInvocation('bash', { command: 'ls' })).toBeNull();
    expect(
      validateToolInvocation('edit', {
        path: 'a',
        old_string: 'x',
        new_string: 'y',
      }),
    ).toBeNull();
  });
});
