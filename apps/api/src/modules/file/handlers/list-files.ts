import { SCOPE_ID_PATTERN } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { invalidRequestError } from '../../../lib/errors';
import { parseListParams } from '../../../lib/pagination';
import { fileService } from '../service';

/** GET /v1/files — 分页列出 File;scope_id 校验 sess_ 前缀后由 service 返回空页 */
export async function listFiles(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), 'files');
  const rawScope = c.req.query('scope_id');
  let scopeId: string | undefined;
  if (rawScope !== undefined) {
    if (!SCOPE_ID_PATTERN.test(rawScope)) {
      throw invalidRequestError('Query parameter scope_id must be a sess_ prefixed session id.', {
        param: 'scope_id',
      });
    }
    scopeId = rawScope;
  }
  const page = await fileService.listFiles(c.env, { ...params, scopeId });
  return c.json(page, 200);
}
