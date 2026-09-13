import { invalidRequestError } from "./errors";

/** RFC 3339 时间戳;列表端点的 created_at 边界参数共用同一校验 */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 校验并解析 RFC 3339 查询参数为 epoch 毫秒;非法抛 400 */
export function parseRfc3339Query(name: string, raw: string): number {
  if (!RFC3339_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw invalidRequestError(`Query parameter ${name} must be a valid RFC 3339 timestamp.`);
  }
  return Date.parse(raw);
}
