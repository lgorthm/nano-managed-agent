import type { Context } from "hono";
import { MAX_TOTAL_BYTES, type RawSkillFile } from "@nano/shared";
import type { AppEnv } from "../env";
import { invalidRequestError, requestTooLargeError } from "./errors";

/** multipart 解析结果:文本字段与文件字段分开,字段名即 Skill 内相对路径 */
export interface ParsedMultipart {
  textFields: Record<string, string>;
  files: RawSkillFile[];
}

/**
 * 解析 multipart/form-data 请求体,是所有「带文件上传」端点的公共入口:
 * - content-type 必须是 multipart/form-data,否则 400;
 * - 解析前按 Content-Length 预检总量上限(formData() 会把整个请求体读进内存,
 *   预检让恶意大请求在读取之前就被 413 挡下),解析后的精确裁决在规范树归一化中完成;
 * - 字段名重复(两个同名 part)直接 400——路径必须唯一;
 * - File.name 是客户端本地文件名,参与校验会让同一目录在不同机器上传出不同结果,忽略之。
 */
export async function parseMultipart(c: Context<AppEnv>): Promise<ParsedMultipart> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw invalidRequestError("Content-Type must be multipart/form-data.");
  }

  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOTAL_BYTES) {
    throw requestTooLargeError(`Upload exceeds the ${MAX_TOTAL_BYTES} byte limit.`);
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw invalidRequestError("Malformed multipart/form-data body.");
  }

  const textFields: Record<string, string> = {};
  const files: RawSkillFile[] = [];
  const seen = new Set<string>();
  for (const [name, value] of form.entries()) {
    if (seen.has(name)) {
      throw invalidRequestError(`Duplicate multipart field name "${name}".`, { param: name });
    }
    seen.add(name);
    if (typeof value === "string") {
      textFields[name] = value;
      continue;
    }
    files.push({ path: name, bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  return { textFields, files };
}
