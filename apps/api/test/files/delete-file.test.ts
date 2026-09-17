import { beforeAll, describe, expect, it } from 'vitest';
import {
  createDefaultAgent,
  createDefaultEnvironment,
  postSession,
  type SessionJson,
} from '../sessions/helpers';
import type { FileJson } from './helpers';
import {
  applyMigrations,
  createDefaultFile,
  deleteFile,
  downloadFile,
  type ErrorEnvelope,
  type FileDeletedJson,
  getFile,
  jsonBody,
  listFiles,
  objectExistsInR2,
  type PageJson,
} from './helpers';

beforeAll(applyMigrations);

describe('DELETE /v1/files/{fileId}', () => {
  it('删除后返回回执,元数据与内容都不再可读', async () => {
    const uploaded = await createDefaultFile('to be deleted', 'temp.txt', 'text/plain');
    const res = await deleteFile(uploaded.id);
    expect(res.status).toBe(200);
    expect(await jsonBody<FileDeletedJson>(res)).toEqual({
      id: uploaded.id,
      type: 'file_deleted',
    });

    expect((await getFile(uploaded.id)).status).toBe(404);
    expect((await downloadFile(uploaded.id)).status).toBe(404);
    // 删除顺序是先 D1 后 R2:R2 对象也应已被清理
    expect(await objectExistsInR2(uploaded.id)).toBe(false);
  });

  it('列表不再包含已删除的 File', async () => {
    const uploaded = await createDefaultFile('listed then deleted');
    await deleteFile(uploaded.id);
    const page = await jsonBody<PageJson<FileJson>>(await listFiles('?limit=100'));
    expect(page.data.some((f) => f.id === uploaded.id)).toBe(false);
  });

  it('重复删除返回 404(不存在语义)', async () => {
    const uploaded = await createDefaultFile('delete me twice');
    expect((await deleteFile(uploaded.id)).status).toBe(200);
    const res = await deleteFile(uploaded.id);
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe('not_found_error');
  });

  it('删除后同文件名可重新上传,新 id 独立', async () => {
    const first = await createDefaultFile('reusable name', 'a.txt', 'text/plain');
    await deleteFile(first.id);
    const second = await createDefaultFile('reusable name', 'a.txt', 'text/plain');
    expect(second.id).not.toBe(first.id);
    expect((await getFile(second.id)).status).toBe(200);
  });

  it('不存在的 id 返回 404,缺少凭证返回 401', async () => {
    expect((await deleteFile('file_01911111-3333-7444-8555-666666666666')).status).toBe(404);
    expect((await deleteFile('whatever', { Authorization: '' })).status).toBe(401);
  });
});

describe('DELETE /v1/files/{fileId} 会话挂载引用检查(Session 引入后的回填)', () => {
  it('被未归档会话挂载的 File 拒绝删除(400)', async () => {
    const file = await createDefaultFile();
    const _session = await jsonBody<SessionJson>(
      await postSession({
        agent: (await createDefaultAgent()).id,
        environment_id: (await createDefaultEnvironment()).id,
        resources: [{ type: 'file', file_id: file.id }],
      }),
    );
    const res = await deleteFile(file.id);
    expect(res.status).toBe(400);
    const error = await jsonBody<ErrorEnvelope>(res);
    expect(error.error.type).toBe('invalid_request_error');
    expect(error.error.message).toContain('mounted');

    // 拒绝删除后 File 仍可读
    expect((await getFile(file.id)).status).toBe(200);
  });

  it('解除挂载或删除/归档会话后,File 恢复可删', async () => {
    // 归档该会话 → 挂载不再阻止删除
    const fileA = await createDefaultFile();
    const sessionA = await jsonBody<SessionJson>(
      await postSession({
        agent: (await createDefaultAgent()).id,
        environment_id: (await createDefaultEnvironment()).id,
        resources: [{ type: 'file', file_id: fileA.id }],
      }),
    );
    const { archiveSessionViaApi } = await import('../sessions/helpers');
    expect((await archiveSessionViaApi(sessionA.id)).status).toBe(200);
    expect((await deleteFile(fileA.id)).status).toBe(200);

    // 主动卸载 → File 恢复可删
    const fileB = await createDefaultFile();
    const sessionB = await jsonBody<SessionJson>(
      await postSession({
        agent: (await createDefaultAgent()).id,
        environment_id: (await createDefaultEnvironment()).id,
        resources: [{ type: 'file', file_id: fileB.id }],
      }),
    );
    const { listResources, deleteResource } = await import('../sessions/helpers');
    const mounts = await jsonBody<PageJson<{ id: string }>>(await listResources(sessionB.id));
    expect((await deleteResource(sessionB.id, mounts.data[0]!.id)).status).toBe(200);
    expect((await deleteFile(fileB.id)).status).toBe(200);
  });
});
