/**
 * 统一错误信封,结构见 docs/agent/api/README.md:
 * 所有非 2xx 响应均为 { type: "error", error: {...}, request_id }。
 */

/** 错误类型枚举,与 GLM Managed Agents 保持一致 */
export const ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/** 信封中 error 字段的形状 */
export interface ApiErrorBody {
  type: ErrorType;
  message: string;
  details?: Record<string, unknown>;
}

/** 完整错误信封 */
export interface ErrorResponse {
  type: 'error';
  error: ApiErrorBody;
  request_id: string;
}
