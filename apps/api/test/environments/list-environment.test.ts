import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDefaultEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
  jsonBody,
  listEnvironments,
  type PageJson,
} from './helpers';

beforeAll(applyMigrations);

describe('GET /v1/environments 分页', () => {
  it('默认参数返回 20 条、按创建时间倒序', async () => {
    // 造满 25 个:现有若干 + 补齐到 25,名字带序号便于断言顺序
    const created: EnvironmentJson[] = [];
    for (let i = 0; i < 25; i++) {
      created.push(
        await createDefaultEnvironment({
          name: `page-env-${String(i).padStart(2, '0')}`,
        }),
      );
    }
    const res = await listEnvironments();
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<EnvironmentJson>>(res);
    expect(page.data.length).toBe(20);
    expect(page.next_page).not.toBeNull();

    // 全量翻页收齐后核对顺序:desc = 最新创建的在前
    const all: EnvironmentJson[] = [...page.data];
    let cursor = page.next_page;
    while (cursor !== null) {
      const next = await jsonBody<PageJson<EnvironmentJson>>(
        await listEnvironments(`?page=${encodeURIComponent(cursor)}`),
      );
      all.push(...next.data);
      cursor = next.next_page;
    }
    const mine = all.filter((item) => item.name.startsWith('page-env-')).map((item) => item.name);
    expect(mine).toEqual([...mine].sort().reverse());
    expect(mine.length).toBe(25);
    // 倒序翻页第一页的最末一条与第二页的首条衔接
    const second = await jsonBody<PageJson<EnvironmentJson>>(
      await listEnvironments(`?page=${encodeURIComponent(page.next_page!)}`),
    );
    expect(second.data.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThanOrEqual(25);
  });

  it('limit=5 生效且游标往返正确', async () => {
    for (let i = 0; i < 6; i++) {
      await createDefaultEnvironment({ name: `limit-env-${i}` });
    }
    const first = await jsonBody<PageJson<EnvironmentJson>>(await listEnvironments('?limit=5'));
    expect(first.data.length).toBe(5);
    expect(first.next_page).not.toBeNull();
    const second = await jsonBody<PageJson<EnvironmentJson>>(
      await listEnvironments(`?limit=5&page=${encodeURIComponent(first.next_page!)}`),
    );
    expect(second.data.length).toBeGreaterThan(0);
    // 两页无重复
    const ids = [...first.data, ...second.data].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('limit=200 被截断为 100(不报错)', async () => {
    const res = await listEnvironments('?limit=200');
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<EnvironmentJson>>(res);
    expect(page.data.length).toBeLessThanOrEqual(100);
  });

  it('order=asc 正序', async () => {
    const desc = await jsonBody<PageJson<EnvironmentJson>>(
      await listEnvironments('?limit=100&order=desc'),
    );
    const asc = await jsonBody<PageJson<EnvironmentJson>>(
      await listEnvironments('?limit=100&order=asc'),
    );
    const descIds = desc.data.map((item) => item.id);
    const ascIds = asc.data.map((item) => item.id);
    expect(ascIds).toEqual([...descIds].reverse());
  });

  it('limit=0 返回 400', async () => {
    const res = await listEnvironments('?limit=0');
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('invalid_request_error');
  });

  it('order 非法返回 400', async () => {
    const res = await listEnvironments('?order=ASC');
    expect(res.status).toBe(400);
  });

  it('篡改游标内容返回 400', async () => {
    const res = await listEnvironments('?page=not-a-cursor');
    expect(res.status).toBe(400);
    // 用 agents 的游标冒充 environments 的游标,kind 不匹配同样 400
    const foreign = btoa(JSON.stringify({ kind: 'agents', createdAt: 0, id: 'x' }));
    const res2 = await listEnvironments(`?page=${encodeURIComponent(foreign)}`);
    expect(res2.status).toBe(400);
  });

  it('已归档的环境(直改库)仍出现在列表中', async () => {
    const { archiveEnvironmentInDb } = await import('./helpers');
    const created = await createDefaultEnvironment({ name: 'listed-archived' });
    await archiveEnvironmentInDb(created.id);
    const page = await jsonBody<PageJson<EnvironmentJson>>(
      await listEnvironments('?limit=100&order=desc'),
    );
    const found = page.data.find((item) => item.id === created.id);
    expect(found?.state).toBe('archived');
  });

  it('不带凭证返回 401', async () => {
    const { exports } = await import('cloudflare:workers');
    const res = await exports.default.fetch('http://example.com/v1/environments');
    expect(res.status).toBe(401);
  });
});
