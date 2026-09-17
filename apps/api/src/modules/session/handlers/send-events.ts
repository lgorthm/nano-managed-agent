import { SendEventsRequestSchema } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseAndValidateBody } from '../../../lib/body';
import { sessionService } from '../service';

/** POST /v1/sessions/{sessionId}/events — 追加输入事件并触发处理(runtime.md §4.2) */
export async function sendSessionEvents(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, SendEventsRequestSchema);
  const result = await sessionService.sendEvents(
    c.env,
    c.req.param('sessionId') ?? '',
    input.events,
  );
  return c.json(result, 200);
}
