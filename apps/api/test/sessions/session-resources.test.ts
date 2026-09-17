import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  archiveSessionInDb,
  createDefaultAgent,
  createDefaultEnvironment,
  createDefaultFile,
  createDefaultSession,
  deleteResource,
  type ErrorEnvelope,
  type FileResourceJson,
  getResource,
  jsonBody,
  listResources,
  type PageJson,
  postResource,
  postSession,
  type SessionJson,
} from './helpers';

beforeAll(applyMigrations);

/** 建一个带两个挂载文件的会话,返回会话与两个文件 */
async function sessionWithTwoMounts() {
  const agent = await createDefaultAgent();
  const environment = await createDefaultEnvironment();
  const [fileA, fileB] = await Promise.all([createDefaultFile(), createDefaultFile()]);
  const session = await jsonBody<SessionJson>(
    await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: 'file', file_id: fileA.id, mount_path: 'raw/a.csv' },
        { type: 'file', file_id: fileB.id, mount_path: 'raw/b.csv' },
      ],
    }),
  );
  return { session, fileA, fileB };
}

describe('POST /v1/sessions/{sessionId}/resources 挂载', () => {
  it('省略 mount_path 得默认路径;相对路径归一化回显;响应 201', async () => {
    const session = await createDefaultSession();
    const file = await createDefaultFile();

    const defaulted = await jsonBody<FileResourceJson>(
      await postResource(session.id, { type: 'file', file_id: file.id }),
    );
    expect(defaulted.mount_path).toBe(`/mnt/session/uploads/${file.id}`);
    expect(defaulted.type).toBe('file');
    expect(defaulted.id).toMatch(/^sres_/);

    const named = await jsonBody<FileResourceJson>(
      await postResource(session.id, {
        type: 'file',
        file_id: file.id,
        mount_path: 'datasets/q2.csv',
      }),
    );
    expect(named.mount_path).toBe('/mnt/session/uploads/datasets/q2.csv');
    // 同一 file 允许挂不同路径
    expect(named.id).not.toBe(defaulted.id);
  });

  it('逃逸、重叠、file 不存在、非法类型分别 400', async () => {
    const { session, fileA } = await sessionWithTwoMounts();
    const other = await createDefaultFile();

    const escapeAttempt = await postResource(session.id, {
      type: 'file',
      file_id: other.id,
      mount_path: '../up',
    });
    expect(escapeAttempt.status).toBe(400);

    // 与既有挂载 /mnt/session/uploads/raw/a.csv 前缀重叠(挂到 raw 目录本身)
    const overlap = await postResource(session.id, {
      type: 'file',
      file_id: other.id,
      mount_path: 'raw',
    });
    expect(overlap.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(overlap)).error.message).toContain('overlaps');

    // 兄弟路径(同目录下的另一个文件)不算重叠,允许
    const sibling = await postResource(session.id, {
      type: 'file',
      file_id: other.id,
      mount_path: 'raw/inner.csv',
    });
    expect(sibling.status).toBe(201);

    // 完全相同路径也被拒(服务层检查)
    const duplicate = await postResource(session.id, {
      type: 'file',
      file_id: other.id,
      mount_path: 'raw/a.csv',
    });
    expect(duplicate.status).toBe(400);

    const missing = await postResource(session.id, {
      type: 'file',
      file_id: 'file_00000000-0000-7000-8000-000000000000',
    });
    expect(missing.status).toBe(400);

    const wrongType = await postResource(session.id, {
      type: 'memory_store',
      memory_store_id: 'ms_1',
    });
    expect(wrongType.status).toBe(400);
    expect(fileA.id).toMatch(/^file_/);
  });

  it('会话不存在 404;已归档会话挂载 409', async () => {
    expect(
      (
        await postResource('sess_00000000-0000-7000-8000-000000000000', {
          type: 'file',
          file_id: 'file_x',
        })
      ).status,
    ).toBe(404);

    const session = await createDefaultSession();
    const file = await createDefaultFile();
    await archiveSessionInDb(session.id);
    const res = await postResource(session.id, {
      type: 'file',
      file_id: file.id,
    });
    expect(res.status).toBe(409);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain('session_archived');
  });
});

describe('GET /v1/sessions/{sessionId}/resources 列表与单查', () => {
  it('分页列出挂载资源,游标翻页', async () => {
    const { session } = await sessionWithTwoMounts();
    const page1 = await jsonBody<PageJson<FileResourceJson>>(
      await listResources(session.id, '?limit=1'),
    );
    expect(page1.data).toHaveLength(1);
    expect(page1.next_page).not.toBeNull();
    const page2 = await jsonBody<PageJson<FileResourceJson>>(
      await listResources(session.id, `?limit=1&page=${encodeURIComponent(page1.next_page!)}`),
    );
    expect(page2.data).toHaveLength(1);
    expect(page2.next_page).toBeNull();
    const paths = [...page1.data, ...page2.data].map((row) => row.mount_path);
    expect(paths).toContain('/mnt/session/uploads/raw/a.csv');
    expect(paths).toContain('/mnt/session/uploads/raw/b.csv');
  });

  it('归档会话仍可列出资源;单查命中与 404', async () => {
    const { session } = await sessionWithTwoMounts();
    await archiveSessionInDb(session.id);
    const page = await jsonBody<PageJson<FileResourceJson>>(await listResources(session.id));
    expect(page.data).toHaveLength(2);

    const target = page.data[0]!;
    const hit = await getResource(session.id, target.id);
    expect((await jsonBody<FileResourceJson>(hit)).id).toBe(target.id);

    // 不属于该会话的 resourceId 视为不存在
    expect(
      (await getResource(session.id, 'sres_00000000-0000-7000-8000-000000000000')).status,
    ).toBe(404);
    expect((await listResources('sess_00000000-0000-7000-8000-000000000000')).status).toBe(404);
  });
});

describe('DELETE /v1/sessions/{sessionId}/resources/{resourceId} 卸载', () => {
  it('卸载成功返回回执,重复卸载 404,File 不受影响', async () => {
    const { session, fileA } = await sessionWithTwoMounts();
    const page = await jsonBody<PageJson<FileResourceJson>>(await listResources(session.id));
    const target = page.data.find((row) => row.file_id === fileA.id)!;

    const res = await deleteResource(session.id, target.id);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      id: target.id,
      type: 'session_resource_deleted',
    });

    expect((await deleteResource(session.id, target.id)).status).toBe(404);
    const remaining = await jsonBody<PageJson<FileResourceJson>>(await listResources(session.id));
    expect(remaining.data).toHaveLength(1);

    const { getFile } = await import('../files/helpers');
    expect((await getFile(fileA.id)).status).toBe(200);
  });

  it('已归档会话卸载 409;会话不存在 404', async () => {
    const { session } = await sessionWithTwoMounts();
    await archiveSessionInDb(session.id);
    const page = await jsonBody<PageJson<FileResourceJson>>(await listResources(session.id));
    const res = await deleteResource(session.id, page.data[0]!.id);
    expect(res.status).toBe(409);

    expect(
      (await deleteResource('sess_00000000-0000-7000-8000-000000000000', 'sres_x')).status,
    ).toBe(404);
  });
});
