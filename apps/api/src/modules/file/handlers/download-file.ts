import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { fileService } from "../service";
import { contentDisposition } from "../serialize";

/** GET /v1/files/{fileId}/content — 下载原始内容,响应头由存储的元数据决定 */
export async function downloadFileContent(c: Context<AppEnv>) {
  const result = await fileService.downloadFileContent(c.env, c.req.param("fileId") ?? "");
  return c.newResponse(result.body, 200, {
    "content-type": result.mimeType,
    "content-disposition": contentDisposition(result.filename),
    etag: result.etag,
  });
}
