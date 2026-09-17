import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { fileService } from '../service';

/** DELETE /v1/files/{fileId} — 删除元数据与内容 */
export async function deleteFile(c: Context<AppEnv>) {
  const response = await fileService.deleteFile(c.env, c.req.param('fileId') ?? '');
  return c.json(response, 200);
}
