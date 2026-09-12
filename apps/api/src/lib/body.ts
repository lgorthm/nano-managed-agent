import type { Context } from "hono";
import type { AppEnv } from "../env";
import { invalidRequestError } from "./errors";

/**
 * 解析 JSON 请求体;坏 JSON 统一转为 invalid_request_error。
 * 这里只做传输层解析,结构校验由调用方用 @nano/shared 的 zod schema 完成。
 */
export async function parseJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequestError("Request body is not valid JSON.");
  }
}

/** zod schema 的结构化子集,避免传输层直接依赖 zod */
interface Validator<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

/** 用 schema 校验已解析的 JSON;失败时 details 携带逐字段的问题路径与消息 */
function validateBody<T>(raw: unknown, schema: Validator<T>): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    }));
    throw invalidRequestError("Request validation failed.", { issues });
  }
  return result.data;
}

/** 解析并校验 JSON 请求体 */
export async function parseAndValidateBody<T>(c: Context<AppEnv>, schema: Validator<T>): Promise<T> {
  return validateBody(await parseJsonBody(c), schema);
}

/**
 * 同 parseAndValidateBody,但空请求体按 {} 处理。
 * GLM 的更新端点 requestBody required: false,省略 body 等价于空补丁。
 */
export async function parseAndValidateOptionalBody<T>(
  c: Context<AppEnv>,
  schema: Validator<T>,
): Promise<T> {
  const text = await c.req.text();
  if (text.trim() === "") return validateBody({}, schema);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalidRequestError("Request body is not valid JSON.");
  }
  return validateBody(raw, schema);
}
