/**
 * GLM Managed Agents API 的公共结构。
 * 形状来自 references/api 内嵌的 OpenAPI 定义,端点以
 * https://agent-api.bigmodel.cn/api 为服务入口(已验证)。
 */

/** 所有 Managed Agents 请求必须携带的协议版本头 */
export const ZAI_VERSION_HEADER = "2026-05-26";

/** 所有 Managed Agents 请求必须携带的 beta 标识头 */
export const ZAI_BETA_HEADER = "managed-agents-2026-05-26";

/** Managed Agents 服务入口(worker 代理的目标地址) */
export const GLM_API_BASE = "https://agent-api.bigmodel.cn/api";

/** 分页信封:翻页使用响应中的 next_page 游标(null 表示没有下一页) */
export interface Page<T> {
  data: T[];
  next_page: string | null;
}

/** 列表接口的公共查询参数 */
export interface ListQuery {
  /** 每页数量;大于 100 时服务端截断为 100 */
  limit?: number;
  order?: "asc" | "desc";
  /** 上一页返回的 opaque cursor */
  page?: string;
}

/** 客户端自定义元数据,最多 16 个键 */
export type Metadata = Record<string, string>;

export type GlmErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

/** GLM 错误响应信封 */
export interface GlmErrorBody {
  type: "error";
  error: {
    type: GlmErrorType;
    message: string;
    details?: Record<string, unknown>;
  };
  request_id: string;
}
