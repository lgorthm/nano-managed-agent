import { describe, expect, it } from 'vitest';
import type { NormalizedAgentToolset, NormalizedBuiltinToolset } from '../../src';
import { AgentCreateRequestSchema, normalizeAgentConfig } from '../../src';

/** 走完整链路:先 schema 解析再归一化,与线上路径一致 */
function normalize(body: unknown) {
  const parsed = AgentCreateRequestSchema.parse(body);
  return normalizeAgentConfig(parsed);
}

/** 断言并收窄为内置工具集(绕开 noUncheckedIndexedAccess 的 undefined) */
function asBuiltinToolset(toolset: NormalizedAgentToolset | undefined): NormalizedBuiltinToolset {
  if (toolset?.type !== 'agent_toolset_20260601') {
    throw new Error(`expected agent_toolset_20260601, got ${JSON.stringify(toolset)}`);
  }
  return toolset;
}

describe('normalizeAgentConfig 模型归一化', () => {
  it('字符串简写按模型补全默认 effort 与 speed', () => {
    expect(normalize({ name: 'a', model: 'glm-5.3' }).model).toEqual({
      id: 'glm-5.3',
      effort: 'max',
      speed: 'standard',
    });
    expect(normalize({ name: 'a', model: 'glm-5.3-flash' }).model).toEqual({
      id: 'glm-5.3-flash',
      effort: 'high',
      speed: 'standard',
    });
  });

  it('对象形态显式 effort 保留', () => {
    expect(normalize({ name: 'a', model: { id: 'glm-5.3', effort: 'low' } }).model.effort).toBe(
      'low',
    );
  });

  it('对象形态 effort 为 null 时取默认', () => {
    expect(normalize({ name: 'a', model: { id: 'glm-5.3', effort: null } }).model.effort).toBe(
      'max',
    );
  });

  it('speed 省略或为 null 时补为 standard', () => {
    expect(normalize({ name: 'a', model: { id: 'glm-5.3' } }).model.speed).toBe('standard');
    expect(normalize({ name: 'a', model: { id: 'glm-5.3', speed: null } }).model.speed).toBe(
      'standard',
    );
  });
});

describe('normalizeAgentConfig 工具集归一化', () => {
  it('省略 tools 时归一化为空数组', () => {
    expect(normalize({ name: 'a', model: 'glm-5.3' }).tools).toEqual([]);
  });

  it('default_config 省略时补为 enabled=true、always_allow', () => {
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [{ type: 'agent_toolset_20260601' }],
    });
    expect(config.tools[0]).toEqual({
      type: 'agent_toolset_20260601',
      default_config: {
        enabled: true,
        permission_policy: { type: 'always_allow' },
      },
      configs: [],
    });
  });

  it('configs 继承显式 default_config', () => {
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [
        {
          type: 'agent_toolset_20260601',
          default_config: {
            enabled: false,
            permission_policy: { type: 'always_ask' },
          },
          configs: [{ name: 'bash' }],
        },
      ],
    });
    const toolset = asBuiltinToolset(config.tools[0]);
    expect(toolset.configs).toEqual([
      {
        name: 'bash',
        enabled: false,
        permission_policy: { type: 'always_ask' },
      },
    ]);
  });

  it('configs 覆盖 default_config 的字段', () => {
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [
        {
          type: 'agent_toolset_20260601',
          configs: [
            {
              name: 'edit',
              enabled: false,
              permission_policy: { type: 'always_ask' },
            },
          ],
        },
      ],
    });
    const toolset = asBuiltinToolset(config.tools[0]);
    expect(toolset.default_config).toEqual({
      enabled: true,
      permission_policy: { type: 'always_allow' },
    });
    expect(toolset.configs).toEqual([
      {
        name: 'edit',
        enabled: false,
        permission_policy: { type: 'always_ask' },
      },
    ]);
  });

  it('configs 中 null 字段继承 default_config', () => {
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [
        {
          type: 'agent_toolset_20260601',
          default_config: { enabled: false },
          configs: [
            {
              name: 'read',
              enabled: null,
              permission_policy: { type: 'always_ask' },
            },
          ],
        },
      ],
    });
    const toolset = asBuiltinToolset(config.tools[0]);
    expect(toolset.configs).toEqual([
      {
        name: 'read',
        enabled: false,
        permission_policy: { type: 'always_ask' },
      },
    ]);
  });

  it('mcp_toolset 保留 mcp_server_name 并归一化配置', () => {
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [
        {
          type: 'mcp_toolset',
          mcp_server_name: 'kb',
          configs: [{ name: 'search' }],
        },
      ],
      mcp_servers: [{ type: 'url', name: 'kb', url: 'https://mcp.example.com/mcp' }],
    });
    expect(config.tools[0]).toEqual({
      type: 'mcp_toolset',
      mcp_server_name: 'kb',
      default_config: {
        enabled: true,
        permission_policy: { type: 'always_allow' },
      },
      configs: [
        {
          name: 'search',
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
      ],
    });
  });

  it('custom 工具原样透传', () => {
    const inputSchema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    } as const;
    const config = normalize({
      name: 'a',
      model: 'glm-5.3',
      tools: [
        {
          type: 'custom',
          name: 'lookup_order',
          description: '查询订单',
          input_schema: inputSchema,
        },
      ],
    });
    expect(config.tools[0]).toEqual({
      type: 'custom',
      name: 'lookup_order',
      description: '查询订单',
      input_schema: inputSchema,
    });
  });
});

describe('normalizeAgentConfig 标量与元数据', () => {
  it('system 与 description 省略时归一化为 null', () => {
    const config = normalize({ name: 'a', model: 'glm-5.3' });
    expect(config.system).toBeNull();
    expect(config.description).toBeNull();
  });

  it('metadata 省略时归一化为空对象,提供时原样保留', () => {
    expect(normalize({ name: 'a', model: 'glm-5.3' }).metadata).toEqual({});
    expect(
      normalize({ name: 'a', model: 'glm-5.3', metadata: { team: 'infra' } }).metadata,
    ).toEqual({
      team: 'infra',
    });
  });
});
