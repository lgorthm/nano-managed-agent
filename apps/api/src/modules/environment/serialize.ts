import type { EnvironmentRow } from "@nano/db";
import type { EnvironmentResponse, NormalizedEnvironmentRecord } from "@nano/shared";

/**
 * Environment 行到 API JSON 的唯一序列化出口:
 * 时间戳转 ISO 8601 UTC,注入不落库的固定字段 type/scope。
 * 六个端点共用,保证回显形状一致。
 */
export function serializeEnvironment(meta: {
  id: string;
  state: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  record: NormalizedEnvironmentRecord;
}): EnvironmentResponse {
  return {
    id: meta.id,
    type: "environment",
    name: meta.record.name,
    description: meta.record.description,
    metadata: meta.record.metadata,
    config: meta.record.config,
    scope: "organization",
    state: meta.state,
    archived_at: meta.archivedAt?.toISOString() ?? null,
    created_at: meta.createdAt.toISOString(),
    updated_at: meta.updatedAt.toISOString(),
  };
}

/** 数据库行 → 归一化记录;service 的更新链路用它把当前行还原成合并基线 */
export function environmentRowToRecord(row: EnvironmentRow): NormalizedEnvironmentRecord {
  return {
    name: row.name,
    description: row.description,
    config: row.config,
    metadata: row.metadata,
  };
}

/** 数据库行 → Environment 响应(读取路径的序列化入口);state 断言回协议枚举 */
export function serializeEnvironmentRow(row: EnvironmentRow): EnvironmentResponse {
  return serializeEnvironment({
    id: row.id,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    record: environmentRowToRecord(row),
  });
}
