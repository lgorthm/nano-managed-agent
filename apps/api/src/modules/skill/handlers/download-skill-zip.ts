import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseSkillVersionParam, skillService } from '../service';

/** GET /v1/skills/{skillId}/versions/{version}/content — 下载版本的 ZIP 内容 */
export async function downloadSkillZip(c: Context<AppEnv>) {
  const version = parseSkillVersionParam(c.req.param('version') ?? '');
  const result = await skillService.downloadSkillZip(c.env, c.req.param('skillId') ?? '', version);
  // directory 来自上传路径,可能含非 ASCII 字符;filename 收敛为 ASCII 安全形态
  const safeName = result.directory.replace(/[^\w.-]+/g, '_') || 'skill';
  // 拷贝进独立的 ArrayBuffer,满足 BodyInit 的类型要求(字节来源可能是 ArrayBufferLike 视图)
  const body = new Uint8Array(result.bytes);
  return c.newResponse(body, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${safeName}-v${result.version}.zip"`,
    etag: `"${result.etag}"`,
  });
}
