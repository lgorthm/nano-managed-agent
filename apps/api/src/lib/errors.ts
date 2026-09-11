import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorBody, ErrorType, ErrorResponse } from "@nano/shared";
import type { AppEnv } from "../env";

/** 错误类型到 HTTP 状态码的映射 */
const STATUS_BY_ERROR_TYPE: Record<ErrorType, ContentfulStatusCode> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  // hono 的状态码类型不含 Cloudflare 专有的 529,语义上用 503 表达过载
  overloaded_error: 503,
};

/** 服务内唯一允许抛出的错误类型;handler 与 service 不自行构造错误响应 */
export class ApiError extends Error {
  constructor(
    readonly errorType: ErrorType,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): ContentfulStatusCode {
    return STATUS_BY_ERROR_TYPE[this.errorType];
  }
}

export function invalidRequestError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("invalid_request_error", message, details);
}

export function notFoundError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("not_found_error", message, details);
}

/** 把任意抛出物渲染成统一错误信封;未预期的错误归为 api_error,不泄露内部细节 */
export function toErrorResponse(err: unknown, requestId: string): ErrorResponse {
  if (err instanceof ApiError) {
    const error: ApiErrorBody =
      err.details === undefined
        ? { type: err.errorType, message: err.message }
        : { type: err.errorType, message: err.message, details: err.details };
    return { type: "error", error, request_id: requestId };
  }
  return {
    type: "error",
    error: { type: "api_error", message: "An unexpected error occurred." },
    request_id: requestId,
  };
}

/** 装配到 Hono 的 onError 处理器:统一渲染错误信封 */
export function honoOnError(err: unknown, c: Context<AppEnv>) {
  if (!(err instanceof ApiError)) {
    console.error("unhandled error:", err);
  }
  const status = err instanceof ApiError ? err.status : 500;
  return c.json(toErrorResponse(err, c.get("requestId")), status);
}
