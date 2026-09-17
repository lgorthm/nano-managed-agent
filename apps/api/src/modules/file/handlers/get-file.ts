import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { fileService } from '../service';

/** GET /v1/files/{fileId} — 获取 File 元数据 */
export async function getFile(c: Context<AppEnv>) {
  const response = await fileService.getFile(c.env, c.req.param('fileId') ?? '');
  return c.json(response, 200);
}
