import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { addSessionFileResource } from './handlers/add-session-file-resource';
import { archiveSession } from './handlers/archive-session';
import { createSession } from './handlers/create-session';
import { deleteSession } from './handlers/delete-session';
import { deleteSessionFileResource } from './handlers/delete-session-file-resource';
import { getSession } from './handlers/get-session';
import { getSessionFileResource } from './handlers/get-session-file-resource';
import { listSessionEvents } from './handlers/list-events';
import { listSessionResources } from './handlers/list-session-resources';
import { listSessions } from './handlers/list-sessions';
import { sendSessionEvents } from './handlers/send-events';
import { streamSessionEvents } from './handlers/stream-events';
import { updateSession } from './handlers/update-session';

/** Session 资源子路由;端点与 docs/session/api/*.md 一一对应(具名路径先于 :sessionId 注册) */
export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.post('/', createSession);
sessionRoutes.get('/', listSessions);
sessionRoutes.post('/:sessionId/archive', archiveSession);
sessionRoutes.post('/:sessionId/events', sendSessionEvents);
sessionRoutes.get('/:sessionId/events', listSessionEvents);
sessionRoutes.get('/:sessionId/events/stream', streamSessionEvents);
sessionRoutes.get('/:sessionId/resources', listSessionResources);
sessionRoutes.post('/:sessionId/resources', addSessionFileResource);
sessionRoutes.get('/:sessionId/resources/:resourceId', getSessionFileResource);
sessionRoutes.delete('/:sessionId/resources/:resourceId', deleteSessionFileResource);
sessionRoutes.get('/:sessionId', getSession);
sessionRoutes.post('/:sessionId', updateSession);
sessionRoutes.delete('/:sessionId', deleteSession);
