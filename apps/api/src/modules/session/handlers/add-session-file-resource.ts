import { FileResourceInputSchema } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseAndValidateBody } from '../../../lib/body';
import { sessionService } from '../service';

/** POST /v1/sessions/{sessionId}/resources — 向未归档会话挂载一个 File */
export async function addSessionFileResource(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, FileResourceInputSchema);
  const resource = await sessionService.addSessionFileResource(
    c.env,
    c.req.param('sessionId') ?? '',
    input,
  );
  return c.json(resource, 201);
}
