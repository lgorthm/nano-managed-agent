/** 列表端点统一的分页参数,约定见 docs/agent/api/README.md 的分页一节 */

export type SortOrder = "asc" | "desc";

export interface ListQuery {
  limit?: number;
  order?: SortOrder;
  page?: string;
}

/** 列表端点统一的响应形状;next_page 为 null 表示没有更多数据 */
export interface Page<T> {
  data: T[];
  next_page: string | null;
}
