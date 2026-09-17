import { describe, expect, it } from 'vitest';
import type { NormalizedEnvironmentConfig, NormalizedEnvironmentPackages } from '../../src';
import {
  EnvironmentCreateRequestSchema,
  normalizeEnvironmentConfig,
  normalizeEnvironmentCreate,
} from '../../src';

/** 走完整链路:先 schema 解析再归一化,与线上路径一致 */
function normalize(body: unknown) {
  const parsed = EnvironmentCreateRequestSchema.parse(body);
  return normalizeEnvironmentCreate(parsed);
}

const EMPTY_PACKAGES: NormalizedEnvironmentPackages = {
  type: 'packages',
  apt: [],
  cargo: [],
  gem: [],
  go: [],
  npm: [],
  pip: [],
};

describe('normalizeEnvironmentConfig 默认值展开', () => {
  it('config 省略或 null 展开为 cloud + 空 packages + unrestricted', () => {
    const expected: NormalizedEnvironmentConfig = {
      type: 'cloud',
      packages: EMPTY_PACKAGES,
      networking: { type: 'unrestricted' },
    };
    expect(normalize({ name: 'a' }).config).toEqual(expected);
    expect(normalize({ name: 'a', config: null }).config).toEqual(expected);
    expect(normalizeEnvironmentConfig(null)).toEqual(expected);
    expect(normalizeEnvironmentConfig(undefined)).toEqual(expected);
  });

  it('packages 省略或 null 规范化为六键空数组', () => {
    expect(normalize({ name: 'a', config: { type: 'cloud' } }).config.packages).toEqual(
      EMPTY_PACKAGES,
    );
    expect(
      normalize({
        name: 'a',
        config: { type: 'cloud', packages: { pip: ['requests'] } },
      }).config.packages,
    ).toEqual({
      ...EMPTY_PACKAGES,
      pip: ['requests'],
    });
  });

  it('networking 省略或 null 规范化为 unrestricted', () => {
    expect(normalize({ name: 'a', config: { type: 'cloud' } }).config.networking).toEqual({
      type: 'unrestricted',
    });
  });
});

describe('包列表去重(保留首次出现顺序)', () => {
  it('重复项去重,顺序保持首次出现', () => {
    const { config } = normalize({
      name: 'a',
      config: { type: 'cloud', packages: { pip: ['b', 'a', 'b', 'c', 'a'] } },
    });
    expect(config.packages.pip).toEqual(['b', 'a', 'c']);
  });

  it('六类管理器独立处理,未声明的为空数组', () => {
    const { config } = normalize({
      name: 'a',
      config: {
        type: 'cloud',
        packages: {
          apt: ['poppler-utils', 'poppler-utils'],
          npm: ['typescript'],
        },
      },
    });
    expect(config.packages.apt).toEqual(['poppler-utils']);
    expect(config.packages.npm).toEqual(['typescript']);
    expect(config.packages.pip).toEqual([]);
  });
});

describe('allowed_hosts 规范化', () => {
  it('小写化 + 排序 + 去重', () => {
    const { config } = normalize({
      name: 'a',
      config: {
        type: 'cloud',
        networking: {
          type: 'limited',
          allowed_hosts: [
            'Zulu.example.com',
            'alpha.example.com',
            'zulu.example.com',
            '*.Internal.example.com',
          ],
        },
      },
    });
    expect(config.networking).toEqual({
      type: 'limited',
      allowed_hosts: ['*.internal.example.com', 'alpha.example.com', 'zulu.example.com'],
      allow_package_managers: false,
      allow_mcp_servers: false,
    });
  });

  it('大小写不同的同一 host 去重为一个', () => {
    const { config } = normalize({
      name: 'a',
      config: {
        type: 'cloud',
        networking: {
          type: 'limited',
          allowed_hosts: ['API.example.com', 'api.example.com'],
        },
      },
    });
    if (config.networking.type !== 'limited') throw new Error('expected limited');
    expect(config.networking.allowed_hosts).toEqual(['api.example.com']);
  });
});

describe('联网开关补全', () => {
  it('limited 的两个开关省略或 null 补为 false', () => {
    const { config } = normalize({
      name: 'a',
      config: { type: 'cloud', networking: { type: 'limited' } },
    });
    expect(config.networking).toEqual({
      type: 'limited',
      allowed_hosts: [],
      allow_package_managers: false,
      allow_mcp_servers: false,
    });
  });

  it('显式值保留', () => {
    const { config } = normalize({
      name: 'a',
      config: {
        type: 'cloud',
        networking: {
          type: 'limited',
          allow_package_managers: true,
          allow_mcp_servers: null,
        },
      },
    });
    expect(config.networking).toEqual({
      type: 'limited',
      allowed_hosts: [],
      allow_package_managers: true,
      allow_mcp_servers: false,
    });
  });
});

describe('normalizeEnvironmentCreate 记录级字段', () => {
  it('description 省略补 null,metadata 默认空对象', () => {
    const record = normalize({ name: 'a' });
    expect(record.name).toBe('a');
    expect(record.description).toBeNull();
    expect(record.metadata).toEqual({});
  });

  it('description 与 metadata 透传', () => {
    const record = normalize({
      name: 'a',
      description: 'd',
      metadata: { team: 'infra' },
    });
    expect(record.description).toBe('d');
    expect(record.metadata).toEqual({ team: 'infra' });
  });
});
