import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseFileUpload } from '../../../lib/multipart';
import { fileService } from '../service';

/** POST /v1/files — multipart 上传单个文件;成功返回 200(GLM 的上传端点即 200) */
export async function uploadFile(c: Context<AppEnv>) {
  const file = await parseFileUpload(c);
  const response = await fileService.uploadFile(c.env, file);
  return c.json(response, 200);
}
