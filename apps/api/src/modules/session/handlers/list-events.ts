import {
  DEFAULT_EVENT_PAGE_LIMIT,
  EVENT_TYPES,
  type EventListFilters,
  type EventType,
} from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { invalidRequestError } from '../../../lib/errors';
import { parseListParams } from '../../../lib/pagination';
import { parseRfc3339Query } from '../../../lib/rfc3339';
import { SESSION_EVENTS_CURSOR_KIND, sessionService } from '../service';

/**
 * 解析事件列表过滤参数(docs/session/api/list-events.md):
 * types 可逗号分隔或重复传入,值必须属于事件类型全集;created_at 四边界为 RFC 3339。
 * 与 statuses[] 同款约定:同时接受 types 与 types[] 两种重复参数写法。
 */
function parseEventFilters(c: Context<AppEnv>): EventListFilters {
  const filters: EventListFilters = {};

  const rawTypes = [...(c.req.queries('types') ?? []), ...(c.req.queries('types[]') ?? [])];
  if (rawTypes.length > 0) {
    const types = rawTypes
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '');
    for (const type of types) {
      if (!(EVENT_TYPES as readonly string[]).includes(type)) {
        throw invalidRequestError(`Query parameter types has an invalid event type "${type}".`, {
          param: 'types',
        });
      }
    }
    if (types.length > 0) filters.types = types as EventType[];
  }

  for (const [suffix, key] of [
    ['gt', 'createdAtGt'],
    ['gte', 'createdAtGte'],
    ['lt', 'createdAtLt'],
    ['lte', 'createdAtLte'],
  ] as const) {
    const raw = c.req.query(`created_at[${suffix}]`);
    if (raw !== undefined) {
      filters[key] = parseRfc3339Query(`created_at[${suffix}]`, raw);
    }
  }
  return filters;
}

/** GET /v1/sessions/{sessionId}/events — 分页读取事件历史(默认 100 条正序) */
export async function listSessionEvents(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), SESSION_EVENTS_CURSOR_KIND, {
    limit: DEFAULT_EVENT_PAGE_LIMIT,
    order: 'asc',
  });
  const filters = parseEventFilters(c);
  const page = await sessionService.listEvents(
    c.env,
    c.req.param('sessionId') ?? '',
    params,
    filters,
  );
  return c.json(page, 200);
}
