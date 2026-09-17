import { describe, expect, it } from 'vitest';
import { AgentCreateRequestSchema, type McpServer } from '../../src';

const validMcpServer: McpServer = {
  type: 'url',
  name: 'kb',
  url: 'https://mcp.example.com/mcp',
};

const validBase = {
  name: 'support-agent',
  model: 'glm-5.3',
};

describe('AgentCreateRequestSchema 单字段规则', () => {
  const cases: Array<{
    name: string;
    body: Record<string, unknown>;
    ok: boolean;
  }> = [
    { name: '最小合法请求', body: validBase, ok: true },
    { name: '缺 name', body: { model: 'glm-5.3' }, ok: false },
    { name: 'name 为空字符串', body: { ...validBase, name: '' }, ok: false },
    {
      name: 'name 超过 256 字符',
      body: { ...validBase, name: 'a'.repeat(257) },
      ok: false,
    },
    { name: '缺 model', body: { name: 'a' }, ok: false },
    { name: 'model 空字符串', body: { ...validBase, model: '' }, ok: false },
    {
      name: 'model 目录外 id(动态模型透传)',
      body: { ...validBase, model: '@cf/zai-org/glm-5.2' },
      ok: true,
    },
    {
      name: 'model 对象缺 id',
      body: { ...validBase, model: { effort: 'low' } },
      ok: false,
    },
    {
      name: 'model effort 非法',
      body: { ...validBase, model: { id: 'glm-5.3', effort: 'medium' } },
      ok: false,
    },
    {
      name: 'model 对象合法',
      body: { ...validBase, model: { id: 'glm-5.3-flash', effort: 'low' } },
      ok: true,
    },
    { name: '未知顶层字段', body: { ...validBase, extra: 1 }, ok: false },
    {
      name: 'system 超过 100000 字符',
      body: { ...validBase, system: 'a'.repeat(100001) },
      ok: false,
    },
    {
      name: 'description 超过 2048 字符',
      body: { ...validBase, description: 'a'.repeat(2049) },
      ok: false,
    },
    {
      name: 'metadata 超过 16 键',
      body: {
        ...validBase,
        metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])),
      },
      ok: false,
    },
    {
      name: 'metadata 键超过 64 字符',
      body: { ...validBase, metadata: { ['k'.repeat(65)]: 'v' } },
      ok: false,
    },
    {
      name: 'metadata 值超过 512 字符',
      body: { ...validBase, metadata: { k: 'v'.repeat(513) } },
      ok: false,
    },
    {
      name: 'tools 超过 128 项',
      body: {
        ...validBase,
        tools: Array.from({ length: 129 }, () => ({
          type: 'agent_toolset_20260601',
        })),
      },
      ok: false,
    },
    {
      name: 'tools 元素类型非法',
      body: { ...validBase, tools: [{ type: 'shell_toolset' }] },
      ok: false,
    },
    {
      name: 'custom 工具缺 input_schema',
      body: {
        ...validBase,
        tools: [{ type: 'custom', name: 't', description: 'd' }],
      },
      ok: false,
    },
    {
      name: 'custom 工具名含空格',
      body: {
        ...validBase,
        tools: [
          {
            type: 'custom',
            name: 'has space',
            description: 'd',
            input_schema: { type: 'object' },
          },
        ],
      },
      ok: false,
    },
    {
      name: 'configs 重复工具名',
      body: {
        ...validBase,
        tools: [
          {
            type: 'agent_toolset_20260601',
            configs: [{ name: 'bash' }, { name: 'bash' }],
          },
        ],
      },
      ok: false,
    },
    {
      name: 'permission_policy 非法',
      body: {
        ...validBase,
        tools: [
          {
            type: 'agent_toolset_20260601',
            default_config: { permission_policy: { type: 'never' } },
          },
        ],
      },
      ok: false,
    },
  ];

  for (const { name, body, ok } of cases) {
    it(`${ok ? '接受' : '拒绝'}: ${name}`, () => {
      expect(AgentCreateRequestSchema.safeParse(body).success).toBe(ok);
    });
  }
});

describe('AgentCreateRequestSchema URL 规则', () => {
  const withServer = (url: string) => ({
    ...validBase,
    mcp_servers: [{ type: 'url', name: 'kb', url }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'kb' }],
  });

  const cases: Array<{ name: string; url: string; ok: boolean }> = [
    { name: '合法 HTTPS', url: 'https://mcp.example.com/mcp', ok: true },
    { name: 'HTTP 被拒绝', url: 'http://mcp.example.com/mcp', ok: false },
    {
      name: '带凭据被拒绝',
      url: 'https://user:pass@mcp.example.com/mcp',
      ok: false,
    },
    {
      name: '带 fragment 被拒绝',
      url: 'https://mcp.example.com/mcp#frag',
      ok: false,
    },
    { name: '空 query 被拒绝', url: 'https://mcp.example.com/mcp?', ok: false },
    {
      name: 'query 以 & 开头被拒绝',
      url: 'https://mcp.example.com/mcp?&a=1',
      ok: false,
    },
    {
      name: '旧式 SSE 路径被拒绝',
      url: 'https://mcp.example.com/sse',
      ok: false,
    },
    {
      name: 'SSE 路径带斜杠被拒绝',
      url: 'https://mcp.example.com/sse/',
      ok: false,
    },
    {
      name: '非空 query 合法',
      url: 'https://mcp.example.com/mcp?token=x',
      ok: true,
    },
  ];

  for (const { name, url, ok } of cases) {
    it(`${ok ? '接受' : '拒绝'}: ${name}`, () => {
      expect(AgentCreateRequestSchema.safeParse(withServer(url)).success).toBe(ok);
    });
  }
});

describe('AgentCreateRequestSchema 跨字段规则', () => {
  it('mcp_toolset 与 mcp_servers 一一对应时合法', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'agent_toolset_20260601' }, { type: 'mcp_toolset', mcp_server_name: 'kb' }],
      mcp_servers: [validMcpServer],
    });
    expect(result.success).toBe(true);
  });

  it('mcp_toolset 引用不存在的 server 被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'kb' }],
      mcp_servers: [],
    });
    expect(result.success).toBe(false);
  });

  it('mcp_servers 没有同名 mcp_toolset 被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [],
      mcp_servers: [validMcpServer],
    });
    expect(result.success).toBe(false);
  });

  it('两个 mcp_toolset 引用同一 server 被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [
        { type: 'mcp_toolset', mcp_server_name: 'kb' },
        { type: 'mcp_toolset', mcp_server_name: 'kb' },
      ],
      mcp_servers: [validMcpServer],
    });
    expect(result.success).toBe(false);
  });

  it('mcp_servers 名称重复被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'kb' }],
      mcp_servers: [validMcpServer, { ...validMcpServer, url: 'https://other.example.com/mcp' }],
    });
    expect(result.success).toBe(false);
  });

  it('配置 skills 但没有 agent_toolset_20260601 被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [],
      skills: [{ type: 'zai', skill_id: 'skl_1', version: '1' }],
    });
    expect(result.success).toBe(false);
  });

  it('配置 skills 且包含 agent_toolset_20260601 合法', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'agent_toolset_20260601' }],
      skills: [{ type: 'zai', skill_id: 'skl_1', version: '1' }],
    });
    expect(result.success).toBe(true);
  });

  it('同一 skill_id 与 version 组合重复被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'agent_toolset_20260601' }],
      skills: [
        { type: 'zai', skill_id: 'skl_1', version: '1' },
        { type: 'zai', skill_id: 'skl_1', version: '1' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('同一 skill_id 不同 version 合法', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [{ type: 'agent_toolset_20260601' }],
      skills: [
        { type: 'zai', skill_id: 'skl_1', version: '1' },
        { type: 'zai', skill_id: 'skl_1', version: '2' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('custom 工具名以 mcp__ 开头被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [
        {
          type: 'custom',
          name: 'mcp__evil',
          description: 'd',
          input_schema: { type: 'object' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('custom 工具名重复被拒绝', () => {
    const custom = {
      type: 'custom',
      name: 'lookup',
      description: 'd',
      input_schema: { type: 'object' },
    } as const;
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [custom, custom],
    });
    expect(result.success).toBe(false);
  });

  it('同一 mcp_toolset 内 configs 名称重复被拒绝', () => {
    const result = AgentCreateRequestSchema.safeParse({
      ...validBase,
      tools: [
        {
          type: 'mcp_toolset',
          mcp_server_name: 'kb',
          configs: [{ name: 'search' }, { name: 'search' }],
        },
      ],
      mcp_servers: [validMcpServer],
    });
    expect(result.success).toBe(false);
  });
});
