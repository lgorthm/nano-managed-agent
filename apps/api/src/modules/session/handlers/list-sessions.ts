import type { Context } from "hono";
import {
  SESSION_STATUSES,
  SESSION_STATUSES_PARAM,
  type SessionListFilters,
  type SessionStatus,
} from "@nano/shared";
import type { AppEnv } from "../../../env";
import { invalidRequestError } from "../../../lib/errors";
import { parseListParams } from "../../../lib/pagination";
import { parseRfc3339Query } from "../../../lib/rfc3339";
import { sessionService } from "../service";

/**
 * 解析 sessions 列表的过滤参数(docs/session/api/list-sessions.md):
 * agent_id/agent_version(必须同用)、statuses[](可重复)、created_at 四边界、
 * include_archived;memory_store_id 一期提供即 400(nano 无 Memory Store 资源)。
 */
function parseSessionFilters(c: Context<AppEnv>): SessionListFilters {
  const query = (name: string) => c.req.query(name);

  if (query("memory_store_id") !== undefined) {
    throw invalidRequestError(
      "Query parameter memory_store_id is not supported: nano has no memory store resources.",
      { param: "memory_store_id" },
    );
  }

  const agentId = query("agent_id");
  const rawAgentVersion = query("agent_version");
  if (rawAgentVersion !== undefined && agentId === undefined) {
    throw invalidRequestError("Query parameter agent_version must be used together with agent_id.");
  }
  let agentVersion: number | undefined;
  if (rawAgentVersion !== undefined) {
    if (!/^\d+$/.test(rawAgentVersion) || Number(rawAgentVersion) < 1) {
      throw invalidRequestError("Query parameter agent_version must be a positive integer.");
    }
    agentVersion = Number(rawAgentVersion);
  }

  const rawStatuses = c.req.queries(SESSION_STATUSES_PARAM);
  let statuses: SessionStatus[] | undefined;
  if (rawStatuses !== undefined && rawStatuses.length > 0) {
    for (const status of rawStatuses) {
      if (!(SESSION_STATUSES as readonly string[]).includes(status)) {
        throw invalidRequestError(
          `Query parameter ${SESSION_STATUSES_PARAM} has an invalid status "${status}".`,
          { param: SESSION_STATUSES_PARAM, allowed: SESSION_STATUSES },
        );
      }
    }
    statuses = rawStatuses as SessionStatus[];
  }

  const rawIncludeArchived = query("include_archived");
  if (rawIncludeArchived !== undefined && rawIncludeArchived !== "true" && rawIncludeArchived !== "false") {
    throw invalidRequestError("Query parameter include_archived must be true or false.");
  }

  const filters: SessionListFilters = {
    includeArchived: rawIncludeArchived === "true",
  };
  if (agentId !== undefined) filters.agentId = agentId;
  if (agentVersion !== undefined) filters.agentVersion = agentVersion;
  if (statuses !== undefined) filters.statuses = statuses;

  for (const [suffix, key] of [
    ["gt", "createdAtGt"],
    ["gte", "createdAtGte"],
    ["lt", "createdAtLt"],
    ["lte", "createdAtLte"],
  ] as const) {
    const raw = query(`created_at[${suffix}]`);
    if (raw !== undefined) {
      filters[key] = parseRfc3339Query(`created_at[${suffix}]`, raw);
    }
  }

  return filters;
}

/** GET /v1/sessions — 过滤 + keyset 分页;默认排除已归档 */
export async function listSessions(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), "sessions");
  const filters = parseSessionFilters(c);
  const page = await sessionService.listSessions(c.env, params, filters);
  return c.json(page, 200);
}
