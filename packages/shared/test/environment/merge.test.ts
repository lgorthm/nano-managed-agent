import { describe, expect, it } from 'vitest';
import type { NormalizedEnvironmentRecord } from '../../src';
import {
  EnvironmentCreateRequestSchema,
  EnvironmentUpdateRequestSchema,
  environmentConfigIssues,
  environmentRecordEquals,
  mergeEnvironmentRecord,
  normalizeEnvironmentCreate,
} from '../../src';

/** 构造归一化当前态:走创建链路,与线上路径一致 */
function currentState(body: unknown): NormalizedEnvironmentRecord {
  return normalizeEnvironmentCreate(EnvironmentCreateRequestSchema.parse(body));
}

function parseUpdate(body: unknown) {
  return EnvironmentUpdateRequestSchema.parse(body);
}

const current = () =>
  currentState({
    name: 'data-analysis-env',
    description: '初始说明',
    metadata: { team: 'infra', env: 'prod' },
    config: {
      type: 'cloud',
      packages: {
        apt: ['poppler-utils'],
        pip: ['pandas'],
        npm: ['typescript'],
      },
      networking: { type: 'unrestricted' },
    },
  });

describe('mergeEnvironmentRecord 更新语义', () => {
  it('空补丁保持不变', () => {
    const state = current();
    expect(mergeEnvironmentRecord(state, parseUpdate({}))).toEqual(state);
  });

  it('name 替换;description 传 null 清空;省略均保持不变', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({ name: 'renamed', description: null }),
    );
    expect(merged.name).toBe('renamed');
    expect(merged.description).toBeNull();
  });

  it('config 整体替换(非深合并):未提及的包管理器列表清空', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: { type: 'cloud', packages: { pip: ['requests'] } },
      }),
    );
    expect(merged.config.packages).toEqual({
      type: 'packages',
      apt: [],
      cargo: [],
      gem: [],
      go: [],
      npm: [], // 此前的 typescript 随整体替换消失
      pip: ['requests'],
    });
  });

  it('config 传 null 恢复默认 cloud 配置;省略保持不变', () => {
    expect(mergeEnvironmentRecord(current(), parseUpdate({ config: null })).config).toEqual({
      type: 'cloud',
      packages: {
        type: 'packages',
        apt: [],
        cargo: [],
        gem: [],
        go: [],
        npm: [],
        pip: [],
      },
      networking: { type: 'unrestricted' },
    });
    expect(mergeEnvironmentRecord(current(), parseUpdate({})).config).toEqual(current().config);
  });

  it('替换进来的 config 先归一化(hosts 小写化排序去重、开关补全)', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: {
          type: 'cloud',
          networking: {
            type: 'limited',
            allowed_hosts: ['B.com', 'a.com', 'b.com'],
            allow_package_managers: true,
          },
        },
      }),
    );
    expect(merged.config.networking).toEqual({
      type: 'limited',
      allowed_hosts: ['a.com', 'b.com'],
      allow_package_managers: true,
      allow_mcp_servers: false,
    });
  });

  it('metadata 按键合并:覆盖、新增、null 删键、未提及保留', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({ metadata: { team: 'data', tier: 'gold', env: null } }),
    );
    expect(merged.metadata).toEqual({ team: 'data', tier: 'gold' });
  });

  it('metadata 整体省略或 null 保持不变', () => {
    expect(mergeEnvironmentRecord(current(), parseUpdate({ metadata: null })).metadata).toEqual({
      team: 'infra',
      env: 'prod',
    });
  });
});

describe('environmentRecordEquals 无变化检测', () => {
  it('合并结果与当前一致时为真', () => {
    const state = current();
    const merged = mergeEnvironmentRecord(
      state,
      parseUpdate({ description: '初始说明', metadata: { team: 'infra' } }),
    );
    expect(environmentRecordEquals(merged, state)).toBe(true);
  });

  it('任何一处不同则为假', () => {
    const state = current();
    expect(
      environmentRecordEquals(mergeEnvironmentRecord(state, parseUpdate({ name: 'x' })), state),
    ).toBe(false);
    expect(
      environmentRecordEquals(
        mergeEnvironmentRecord(state, parseUpdate({ config: { type: 'cloud' } })),
        state,
      ),
    ).toBe(false);
    expect(
      environmentRecordEquals(
        mergeEnvironmentRecord(state, parseUpdate({ metadata: { env: null } })),
        state,
      ),
    ).toBe(false);
  });

  it('提交已归一化的等价 config 判定为无变化(比较基准是归一化候选)', () => {
    const state = current();
    const merged = mergeEnvironmentRecord(
      state,
      parseUpdate({
        config: {
          type: 'cloud',
          packages: {
            apt: ['poppler-utils'],
            pip: ['pandas'],
            npm: ['typescript'],
          },
          networking: { type: 'unrestricted' },
        },
      }),
    );
    expect(environmentRecordEquals(merged, state)).toBe(true);
  });
});

describe('联动校验作用于合并后的完整配置', () => {
  it('替换进来的 config 声明 packages 且切到 limited 未放行,合并结果报错', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: {
          type: 'cloud',
          packages: { pip: ['requests'] },
          networking: { type: 'limited', allowed_hosts: ['pypi.org'] },
        },
      }),
    );
    const issues = environmentConfigIssues(merged.config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('allow_package_managers');
  });

  it('只提交 networking 的 config 会整体替换,packages 清空后 limited 无需放行', () => {
    // config 整体替换(非深合并):未提及的 packages 不保留,联动规则因此不触发
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: {
          type: 'cloud',
          networking: { type: 'limited', allowed_hosts: ['api.example.com'] },
        },
      }),
    );
    expect(environmentConfigIssues(merged.config)).toHaveLength(0);
    expect(merged.config.packages.pip).toEqual([]);
  });

  it('显式 allow_package_managers=true 的合并结果放行', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: {
          type: 'cloud',
          networking: {
            type: 'limited',
            allowed_hosts: ['api.example.com'],
            allow_package_managers: true,
          },
        },
      }),
    );
    expect(environmentConfigIssues(merged.config)).toHaveLength(0);
  });

  it('config 恢复默认(packages 清空)后切 limited 无需放行', () => {
    const merged = mergeEnvironmentRecord(
      current(),
      parseUpdate({
        config: {
          type: 'cloud',
          networking: { type: 'limited', allowed_hosts: ['api.example.com'] },
          packages: { pip: null, apt: null, npm: null },
        },
      }),
    );
    expect(environmentConfigIssues(merged.config)).toHaveLength(0);
  });
});
