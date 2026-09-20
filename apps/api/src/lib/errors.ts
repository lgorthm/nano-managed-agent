import type { ApiErrorBody, ErrorResponse, ErrorType } from '@nano/shared';
import { log, withRequestId } from '@nano/shared/log';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';

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
  readonly status: ContentfulStatusCode;

  /**
   * status 可覆盖默认映射:GLM 的 409 版本冲突用的 error.type 仍是 invalid_request_error,
   * 同一错误类型在不同上下文可能对应不同状态码。
   */
  constructor(
    readonly errorType: ErrorType,
    message: string,
    readonly details?: Record<string, unknown>,
    status?: ContentfulStatusCode,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? STATUS_BY_ERROR_TYPE[errorType];
  }
}

export function invalidRequestError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('invalid_request_error', message, details);
}

export function notFoundError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('not_found_error', message, details);
}

/** 乐观并发冲突:携带的 version 与当前版本不一致,HTTP 409 */
export function conflictError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('invalid_request_error', message, details, 409);
}

/** 上传体超过尺寸上限(单文件或总量),HTTP 413 */
export function requestTooLargeError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('request_too_large', message, details);
}

/** 把任意抛出物渲染成统一错误信封;未预期的错误归为 api_error,不泄露内部细节 */
export function toErrorResponse(err: unknown, requestId: string): ErrorResponse {
  if (err instanceof ApiError) {
    const error: ApiErrorBody =
      err.details === undefined
        ? { type: err.errorType, message: err.message }
        : { type: err.errorType, message: err.message, details: err.details };
    return { type: 'error', error, request_id: requestId };
  }
  return {
    type: 'error',
    error: { type: 'api_error', message: 'An unexpected error occurred.' },
    request_id: requestId,
  };
}

/** 装配到 Hono 的 onError 处理器:统一渲染错误信封 + 错误完成行(每请求恰一条完成行,与中间件的成功行互补) */
export function honoOnError(err: unknown, c: Context<AppEnv>) {
  const requestId = c.get('requestId');
  const isApiError = err instanceof ApiError;
  const status = isApiError ? err.status : 500;
  const fields = {
    method: c.req.method,
    path: c.req.path,
    status,
    ...(isApiError ? { errorType: err.errorType } : {}),
    err,
  };
  // onError 在 Hono 顶层 catch 执行,已离开中间件的 ALS 帧:显式重进入后再记。
  // 级别:未预期错误与 5xx → error;鉴权/限流类 → warn;其余业务 4xx → info
  withRequestId(requestId, () => {
    if (!isApiError || status >= 500) {
      log.error(isApiError ? 'request failed' : 'unhandled error', fields);
    } else if (status === 401 || status === 403 || status === 429) {
      log.warn('request failed', fields);
    } else {
      log.info('request failed', fields);
    }
  });
  const response = c.json(toErrorResponse(err, requestId), status);
  response.headers.set('x-request-id', requestId);
  return response;
}
