import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDefaultFile,
  type ErrorEnvelope,
  type FileJson,
  getFile,
  jsonBody,
} from './helpers';

beforeAll(applyMigrations);

describe('GET /v1/files/{fileId}', () => {
  it('上传后按 id 获取,字段与上传响应完全一致', async () => {
    const uploaded = await createDefaultFile(
      'round trip',
      'notes.txt',
      'text/plain; charset=utf-8',
    );
    const res = await getFile(uploaded.id);
    expect(res.status).toBe(200);
    expect(await jsonBody<FileJson>(res)).toEqual(uploaded);
  });

  it('不存在的 id 返回 404 与完整错误信封', async () => {
    const res = await getFile('file_01911111-3333-7444-8555-666666666666');
    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.request_id).toMatch(/^req_/);
  });

  it('任意非法字符串 path 参数返回 404 而非 500', async () => {
    const res = await getFile('not-a-file-id');
    expect(res.status).toBe(404);
  });

  it('缺少凭证返回 401', async () => {
    const res = await getFile('whatever', { Authorization: '' });
    expect(res.status).toBe(401);
  });
});
