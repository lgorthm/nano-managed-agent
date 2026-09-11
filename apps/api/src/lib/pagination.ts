import type { SortOrder } from "@nano/shared";
import { invalidRequestError } from "./errors";

/** 分页约定见 docs/agent/api/README.md:limit 默认 20,大于 100 时截断为 100 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** 游标负载:kind 前缀防止不同列表端点的游标被混用,其余键为 keyset 定位字段 */
export type CursorPayload = { kind: string } & Record<string, string | number>;

/** 解析后的列表参数 */
export interface ListParams {
  limit: number;
  order: SortOrder;
  cursor: CursorPayload | null;
}

function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

/** 编码 opaque 游标:base64url(JSON) */
export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

/** 解码并校验游标:必须是合法 JSON、对象且 kind 匹配;否则 400 */
export function decodeCursor(kind: string, raw: string): CursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(raw));
  } catch {
    throw invalidRequestError("Invalid page cursor.");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as CursorPayload).kind !== kind
  ) {
    throw invalidRequestError("Invalid page cursor.");
  }
  return payload as CursorPayload;
}

/** 读取游标中必填的数字字段;缺失或类型不符返回 400 */
export function cursorNumberField(payload: CursorPayload, name: string): number {
  const value = payload[name];
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) {
    throw invalidRequestError(`Invalid page cursor: missing numeric field "${name}".`);
  }
  return num;
}

/** 读取游标中必填的字符串字段;缺失返回 400 */
export function cursorStringField(payload: CursorPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value === "") {
    throw invalidRequestError(`Invalid page cursor: missing string field "${name}".`);
  }
  return value;
}

/**
 * 解析 limit/order/page 查询参数:
 * limit 非正整数或非法字符串抛 400,大于 100 截断;order 只接受 asc/desc,默认 desc;
 * page 为上一页返回的 opaque 游标,解码失败(含 kind 不匹配)抛 400。
 */
export function parseListParams(
  getQuery: (name: string) => string | undefined,
  cursorKind: string,
): ListParams {
  const rawLimit = getQuery("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      throw invalidRequestError("Query parameter limit must be a positive integer.");
    }
    const parsed = Number(rawLimit);
    if (parsed < 1) {
      throw invalidRequestError("Query parameter limit must be at least 1.");
    }
    limit = Math.min(parsed, MAX_PAGE_LIMIT);
  }

  const rawOrder = getQuery("order");
  let order: SortOrder = "desc";
  if (rawOrder !== undefined) {
    if (rawOrder !== "asc" && rawOrder !== "desc") {
      throw invalidRequestError("Query parameter order must be asc or desc.");
    }
    order = rawOrder;
  }

  const rawPage = getQuery("page");
  const cursor = rawPage === undefined ? null : decodeCursor(cursorKind, rawPage);

  return { limit, order, cursor };
}
