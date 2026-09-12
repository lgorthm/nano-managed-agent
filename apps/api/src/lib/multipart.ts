import type { Context } from "hono";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, type RawSkillFile } from "@nano/shared";
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

/** 单文件上传的 Content-Length 预检余量:multipart 边界与 part 头的封装开销 */
const MULTIPART_OVERHEAD_SLACK = 64 * 1024;

/**
 * 解析「单文件上传」形态的 multipart(POST /v1/files),与上面的 Skill 目录上传语义不同:
 * - 恰好一个名为 file 的文件字段,其余任何字段(文本或文件)一律 400;
 * - 文件名取 part 的 filename 属性(File.name),而非字段名;
 * - Content-Length 预检在 MAX_FILE_BYTES 之上留出封装开销余量,
 *   精确裁决在服务层按 file.size 完成。
 */
export async function parseFileUpload(c: Context<AppEnv>): Promise<File> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw invalidRequestError("Content-Type must be multipart/form-data.");
  }

  const declaredLength = Number(c.req.header("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FILE_BYTES + MULTIPART_OVERHEAD_SLACK
  ) {
    throw requestTooLargeError(`Upload exceeds the ${MAX_FILE_BYTES} byte limit.`);
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw invalidRequestError("Malformed multipart/form-data body.");
  }

  let file: File | undefined;
  for (const [name, value] of form.entries()) {
    if (name === "file") {
      if (typeof value === "string") {
        throw invalidRequestError('Field "file" must be a file part.', { param: "file" });
      }
      if (file !== undefined) {
        throw invalidRequestError('Multiple "file" parts are not allowed.', { param: "file" });
      }
      file = value;
      continue;
    }
    throw invalidRequestError(`Unknown multipart field "${name}".`, { param: name });
  }
  if (file === undefined) {
    throw invalidRequestError('Multipart request must contain a "file" field.', { param: "file" });
  }
  return file;
}
