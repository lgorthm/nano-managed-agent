import {
  agentVersionRowToConfig,
  archiveSession as archiveSessionRow,
  createSession as createSessionRow,
  type Db,
  deleteSessionResource as deleteSessionResourceRow,
  deleteSession as deleteSessionRow,
  findAgentRow,
  findAgentVersion,
  findEnvironment,
  findFile,
  findFilesByIds,
  findSession,
  findSessionOutputsBySession,
  findSessionResource,
  findSessionResourcesBySessionIds,
  getDb,
  insertSessionResource,
  listSessionResourcesPage,
  listSessionsPage,
  newSessionId,
  newSessionResourceId,
  updateSessionRow,
} from '@nano/db';
import type {
  DeltaEventType,
  EventInput,
  EventListFilters,
  FileResourceInput,
  FileResourceResponse,
  Page,
  PersistedEventJson,
  SessionAgentOverrides,
  SessionCreateRequestInput,
  SessionDeletedResponse,
  SessionListFilters,
  SessionResourceDeletedResponse,
  SessionResponse,
  SessionUpdateRequestInput,
} from '@nano/shared';
import {
  agentConfigIssues,
  deepEqual,
  fileObjectKey,
  MAX_SESSION_FILE_RESOURCES,
  mergeMetadata,
  normalizeMountPath,
  overlapsAnyMountPath,
  resolveSessionAgent,
  toSessionAgentConfig,
} from '@nano/shared';
import { log } from '@nano/shared/log';
import type { Env } from '../../env';
import { conflictError, invalidRequestError, notFoundError } from '../../lib/errors';
import {
  cursorNumberField,
  cursorStringField,
  encodeCursor,
  type ListParams,
} from '../../lib/pagination';
import { assertSkillReferencesResolvable } from '../../lib/skill-refs';
import { sessionDoStub, unwrapDoResult } from '../../runtime/session-do-stub';
import { serializeSession, serializeSessionResource } from './serialize';

/** sessions / session-resources / session-events 列表游标的 kind 前缀,防止互串 */
const SESSIONS_CURSOR_KIND = 'sessions';
const SESSION_RESOURCES_CURSOR_KIND = 'session-resources';
export const SESSION_EVENTS_CURSOR_KIND = 'session-events';

/** 已归档会话的门禁(更新 / 挂载 / 卸载共用) */
function assertSessionNotArchived(archivedAt: Date | null): void {
  if (archivedAt !== null) {
    throw conflictError('Session is archived (session_archived) and cannot be modified.');
  }
}

/** 解析后的 Agent 引用:钉住的 (id, version) + 可选覆盖 */
interface ResolvedAgentReference {
  agentId: string;
  version?: number;
  overrides?: SessionAgentOverrides;
}

/** agent 三形态(ID 字符串 / 固定版本引用 / 带覆盖引用)归一为内部形态 */
function toAgentReference(input: SessionCreateRequestInput): ResolvedAgentReference {
  const raw = input.agent ?? input.agent_id;
  if (raw === undefined) {
    // schema 已保证 agent 与 agent_id 至少其一,此分支仅为类型收窄
    throw invalidRequestError('either agent or the compatible field agent_id must be provided');
  }
  if (typeof raw === 'string') {
    return { agentId: raw };
  }
  if (raw.type === 'agent') {
    return { agentId: raw.id, version: raw.version };
  }
  const { id, version, model, system, tools, skills, mcp_servers } = raw;
  const hasOverride =
    model !== undefined ||
    system !== undefined ||
    tools !== undefined ||
    skills !== undefined ||
    mcp_servers !== undefined;
  return {
    agentId: id,
    version,
    overrides: hasOverride ? { model, system, tools, skills, mcp_servers } : undefined,
  };
}

/** 校验挂载资源:file 存在、mount_path 归一化、互不重叠;返回归一化后的挂载值 */
async function validateFileResources(
  db: Db,
  resources: FileResourceInput[],
): Promise<Array<{ fileId: string; mountPath: string }>> {
  const fileIds = [...new Set(resources.map((resource) => resource.file_id))];
  const found = await findFilesByIds(db, fileIds);
  const missing = fileIds.filter((fileId) => !found.has(fileId));
  if (missing.length > 0) {
    throw invalidRequestError('File resources reference files that do not exist.', { missing });
  }

  const normalized: Array<{ fileId: string; mountPath: string }> = [];
  for (const [index, resource] of resources.entries()) {
    const result = normalizeMountPath(resource.mount_path, resource.file_id);
    if (!result.ok) {
      throw invalidRequestError(result.message, {
        param: `resources[${index}].mount_path`,
      });
    }
    normalized.push({ fileId: resource.file_id, mountPath: result.path });
  }

  for (const [i, candidate] of normalized.entries()) {
    for (let j = 0; j < i; j++) {
      const earlier = normalized[j]!;
      if (overlapsAnyMountPath(candidate.mountPath, [earlier.mountPath])) {
        throw invalidRequestError(
          `resources[${i}].mount_path overlaps the mount path of resources[${j}]`,
          {
            param: `resources[${i}].mount_path`,
            conflicting: earlier.mountPath,
          },
        );
      }
    }
  }
  return normalized;
}

/** 取会话行与全部挂载资源(响应拼装的共同读取形态);行不存在抛 404 */
async function loadSessionWithResources(db: Db, sessionId: string) {
  const row = await findSession(db, sessionId);
  if (!row) {
    throw notFoundError(`Session "${sessionId}" not found.`);
  }
  const resourcesBySession = await findSessionResourcesBySessionIds(db, [sessionId]);
  return { row, resources: resourcesBySession.get(sessionId) ?? [] };
}

/** 会话的挂载资源不存在或跨会话 resourceId 统一转 404 */
function sessionResourceNotFound(resourceId: string): never {
  throw notFoundError(`Session resource "${resourceId}" not found.`);
}

/**
 * Session 资源的业务编排层。
 * 创建的判定链(docs/session/api/create-session.md):
 * agent 引用解析(404/400 分界)→ resolveSessionAgent + 最终配置校验 → skills 引用 →
 * environment 存在与未归档(404/400 分界)→ 资源校验 → 单 batch 落库。
 */
export const sessionService = {
  async createSession(env: Env, input: SessionCreateRequestInput): Promise<SessionResponse> {
    const db = getDb(env);
    const reference = toAgentReference(input);

    // 顶层引用不存在 → 404;version 是配置值,不存在 → 400(附最新版本提示)
    const agentRow = await findAgentRow(db, reference.agentId);
    if (!agentRow) {
      throw notFoundError(`Agent "${reference.agentId}" not found.`);
    }
    const pinnedVersion = reference.version ?? agentRow.currentVersion;
    const versionRow = await findAgentVersion(db, {
      agentId: reference.agentId,
      version: pinnedVersion,
    });
    if (!versionRow) {
      throw invalidRequestError(
        `Agent version ${pinnedVersion} does not exist; the latest version is ${agentRow.currentVersion}.`,
        { param: 'agent.version', latest_version: agentRow.currentVersion },
      );
    }

    const resolved = resolveSessionAgent(
      toSessionAgentConfig(agentVersionRowToConfig(versionRow)),
      reference.overrides,
    );
    const issues = agentConfigIssues(resolved);
    if (issues.length > 0) {
      throw invalidRequestError('Resolved session agent configuration is invalid.', {
        issues: issues.map((issue) => ({
          path: ['agent', ...issue.path.map(String)].join('.'),
          message: issue.message,
        })),
      });
    }
    await assertSkillReferencesResolvable(db, resolved.skills);

    const environment = await findEnvironment(db, input.environment_id);
    if (!environment) {
      throw notFoundError(`Environment "${input.environment_id}" not found.`);
    }
    if (environment.state !== 'active') {
      throw invalidRequestError('Environment is archived and cannot be used by new sessions.', {
        param: 'environment_id',
      });
    }

    const resources = await validateFileResources(db, input.resources);

    const sessionId = newSessionId();
    const now = new Date();
    await createSessionRow(db, {
      session: {
        id: sessionId,
        agentId: reference.agentId,
        agentVersion: pinnedVersion,
        agentConfig: resolved,
        environmentId: environment.id,
        environmentSnapshot: environment.config,
        title: input.title ?? null,
        metadata: input.metadata,
      },
      resources: resources.map((resource) => ({
        id: newSessionResourceId(),
        sessionId,
        fileId: resource.fileId,
        mountPath: resource.mountPath,
      })),
      now,
    });

    // initial_events 走同一条 append → 触发链路(runtime.md §8);DO 失败让创建失败,
    // 不留"会话存在但初始事件丢失"的半态
    if (input.initial_events.length > 0) {
      unwrapDoResult(await sessionDoStub(env, sessionId).sendEvents(input.initial_events));
    }

    const created = await loadSessionWithResources(db, sessionId);
    return serializeSession(created.row, created.resources);
  },

  /** 获取完整会话;不存在时抛 404(归档的会话同样可读) */
  async getSession(env: Env, sessionId: string): Promise<SessionResponse> {
    const loaded = await loadSessionWithResources(getDb(env), sessionId);
    return serializeSession(loaded.row, loaded.resources);
  },

  /**
   * 分页列出会话。默认排除已归档(include_archived=false),
   * 与 GLM Session 语义一致——注意与 agents/environments 列表相反。
   */
  async listSessions(
    env: Env,
    params: ListParams,
    filters: SessionListFilters,
  ): Promise<Page<SessionResponse>> {
    const db = getDb(env);
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, 'createdAt'),
            id: cursorStringField(params.cursor, 'id'),
          };
    const { rows, nextCursor } = await listSessionsPage(db, {
      filters,
      limit: params.limit,
      order: params.order,
      cursor,
    });
    const resourcesBySession = await findSessionResourcesBySessionIds(
      db,
      rows.map((row) => row.id),
    );
    return {
      data: rows.map((row) => serializeSession(row, resourcesBySession.get(row.id) ?? [])),
      next_page: nextCursor
        ? encodeCursor({
            kind: SESSIONS_CURSOR_KIND,
            createdAt: nextCursor.createdAt,
            id: nextCursor.id,
          })
        : null,
    };
  },

  /**
   * 更新会话,判定链(docs/session/api/update-session.md):
   * 取行(null → 404)→ 已归档拒绝(409)→ agent.tools/mcp_servers 仅 idle(409)→
   * 合并(title 替换、metadata 按键合并、快照内整体替换)→ 最终配置校验 →
   * 无变化直接返回现状(不写库、updated_at 不变)→ 守卫式写入(0 行时重读区分 404/409)。
   */
  async updateSession(
    env: Env,
    sessionId: string,
    patch: SessionUpdateRequestInput,
  ): Promise<SessionResponse> {
    const db = getDb(env);
    const row = await findSession(db, sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    assertSessionNotArchived(row.archivedAt);
    if (patch.agent !== undefined && row.status !== 'idle') {
      throw conflictError(
        'Session is not idle (session_not_idle); interrupt the session before updating agent tools.',
      );
    }

    const title = patch.title === undefined ? row.title : (patch.title ?? null);
    const metadata = mergeMetadata(row.metadata, patch.metadata);
    const agentConfig =
      patch.agent === undefined
        ? row.agentConfig
        : resolveSessionAgent(row.agentConfig, {
            tools: patch.agent.tools,
            mcp_servers: patch.agent.mcp_servers,
          });
    if (patch.agent !== undefined) {
      const issues = agentConfigIssues(agentConfig);
      if (issues.length > 0) {
        throw invalidRequestError('Resolved session agent configuration is invalid.', {
          issues: issues.map((issue) => ({
            path: ['agent', ...issue.path.map(String)].join('.'),
            message: issue.message,
          })),
        });
      }
    }

    const unchanged =
      deepEqual(title, row.title) &&
      deepEqual(metadata, row.metadata) &&
      deepEqual(agentConfig, row.agentConfig);
    if (!unchanged) {
      const updated = await updateSessionRow(db, {
        sessionId,
        values: { title, metadata, agentConfig },
        now: new Date(),
      });
      if (!updated) {
        // 守卫落空:期间被删除或被归档;重读区分,不能笼统处理
        const current = await findSession(db, sessionId);
        if (!current) {
          throw notFoundError(`Session "${sessionId}" not found.`);
        }
        assertSessionNotArchived(current.archivedAt);
      } else {
        // 配置实际变更时外发 session.updated(runtime.md §2.3);
        // 事件 append 失败不回滚更新——投影可比事实滞后,事实源在 D1
        await sessionDoStub(env, sessionId)
          .appendControlEvent('session.updated')
          .then(unwrapDoResult)
          .catch((err) => {
            log.error('session.updated append failed', { sessionId, err });
          });
      }
    }

    const archivedRow = await loadSessionWithResources(db, sessionId);
    return serializeSession(archivedRow.row, archivedRow.resources);
  },

  /**
   * 归档会话——与 Agent/Environment 相反,这里不是幂等:
   * 重复归档返回 409(session_archived),running 状态同样 409。
   * 预检只为了给出准确的错误信息,守卫 UPDATE 才是权威判定。
   */
  async archiveSession(env: Env, sessionId: string): Promise<SessionResponse> {
    const db = getDb(env);
    const row = await findSession(db, sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    if (row.archivedAt !== null) {
      throw conflictError('Session is already archived (session_archived).');
    }
    if (row.status === 'running') {
      throw conflictError('Session is running; interrupt the session before archiving.');
    }

    const archived = await archiveSessionRow(db, sessionId, new Date());
    if (!archived) {
      const current = await findSession(db, sessionId);
      if (!current) {
        throw notFoundError(`Session "${sessionId}" not found.`);
      }
      if (current.archivedAt !== null) {
        throw conflictError('Session is already archived (session_archived).');
      }
      throw conflictError('Session is running; interrupt the session before archiving.');
    }

    // 归档即终态(不再有新 turn):顺手销毁沙箱,不让容器等 sleepAfter 自然消亡
    // (runtime.md §4.5);失败只记日志,不阻塞归档
    await sessionDoStub(env, sessionId)
      .destroySandbox()
      .catch((err) => {
        log.error('sandbox destroy on archive failed', { sessionId, err });
      });

    const archivedRow = await loadSessionWithResources(db, sessionId);
    return serializeSession(archivedRow.row, archivedRow.resources);
  },

  /**
   * 硬删除会话及其挂载记录与产出编目;已归档会话允许删除(与"归档即终态"的
   * 直觉相反,GLM 语义如此)。running 拒绝。挂载的 File 是独立资源,不受影响;
   * 产出的 File 生命周期从属于会话,连行带 R2 对象一起清(先 D1 后 R2,
   * 失败留下的孤儿对象不影响正确性,与 delete-file 同一口径)。
   */
  async deleteSession(env: Env, sessionId: string): Promise<SessionDeletedResponse> {
    const db = getDb(env);
    const row = await findSession(db, sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    if (row.status === 'running') {
      throw conflictError('Session is running; interrupt the session before deleting.');
    }
    const outputs = await findSessionOutputsBySession(db, sessionId);
    const outputFileIds = outputs.map((output) => output.fileId);
    const deleted = await deleteSessionRow(db, { sessionId, outputFileIds });
    if (!deleted) {
      const current = await findSession(db, sessionId);
      if (!current) {
        throw notFoundError(`Session "${sessionId}" not found.`);
      }
      throw conflictError('Session is running; interrupt the session before deleting.');
    }
    for (const fileId of outputFileIds) {
      const key = fileObjectKey(fileId);
      await env.FILES.delete(key).catch((err) => {
        log.error('orphan R2 object after session delete', { sessionId, key, err });
      });
    }
    return { id: sessionId, type: 'session_deleted' };
  },

  /** 挂载一个 File:未归档门禁 → file 存在 → mount_path 归一化与重叠 → 上限 → 插入 */
  async addSessionFileResource(
    env: Env,
    sessionId: string,
    input: FileResourceInput,
  ): Promise<FileResourceResponse> {
    const db = getDb(env);
    const session = await findSession(db, sessionId);
    if (!session) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    assertSessionNotArchived(session.archivedAt);

    const file = await findFile(db, input.file_id);
    if (!file) {
      throw invalidRequestError(`File "${input.file_id}" does not exist.`, {
        param: 'file_id',
      });
    }

    const existing = await findSessionResourcesBySessionIds(db, [sessionId]);
    const mounted = existing.get(sessionId) ?? [];
    if (mounted.length >= MAX_SESSION_FILE_RESOURCES) {
      throw invalidRequestError(
        `Session already has the maximum of ${MAX_SESSION_FILE_RESOURCES} file resources.`,
      );
    }

    const normalized = normalizeMountPath(input.mount_path, input.file_id);
    if (!normalized.ok) {
      throw invalidRequestError(normalized.message, { param: 'mount_path' });
    }
    if (
      overlapsAnyMountPath(
        normalized.path,
        mounted.map((row) => row.mountPath),
      )
    ) {
      throw invalidRequestError('mount_path overlaps an existing mount.', {
        param: 'mount_path',
        mount_path: normalized.path,
      });
    }

    const resourceId = newSessionResourceId();
    const now = new Date();
    try {
      await insertSessionResource(db, {
        id: resourceId,
        sessionId,
        fileId: input.file_id,
        mountPath: normalized.path,
        now,
      });
    } catch (err) {
      // 服务层重叠检查存在并发窗口;完全相同路径由 UNIQUE 约束兜底,转 400 而非 500
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw invalidRequestError('mount_path overlaps an existing mount.', {
          param: 'mount_path',
          mount_path: normalized.path,
        });
      }
      throw err;
    }
    return serializeSessionResource({
      id: resourceId,
      fileId: input.file_id,
      mountPath: normalized.path,
      createdAt: now,
      updatedAt: now,
    });
  },

  /** 分页列出会话的挂载资源(归档会话同样可列出) */
  async listSessionResources(
    env: Env,
    sessionId: string,
    params: ListParams,
  ): Promise<Page<FileResourceResponse>> {
    const db = getDb(env);
    const session = await findSession(db, sessionId);
    if (!session) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, 'createdAt'),
            id: cursorStringField(params.cursor, 'id'),
          };
    const { rows, nextCursor } = await listSessionResourcesPage(db, {
      sessionId,
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map(serializeSessionResource),
      next_page: nextCursor
        ? encodeCursor({
            kind: SESSION_RESOURCES_CURSOR_KIND,
            createdAt: nextCursor.createdAt,
            id: nextCursor.id,
          })
        : null,
    };
  },

  /** 获取单个挂载资源;resourceId 必须属于该会话,否则视同不存在 */
  async getSessionFileResource(
    env: Env,
    sessionId: string,
    resourceId: string,
  ): Promise<FileResourceResponse> {
    const db = getDb(env);
    const session = await findSession(db, sessionId);
    if (!session) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    const row = await findSessionResource(db, { sessionId, resourceId });
    if (!row) {
      sessionResourceNotFound(resourceId);
    }
    return serializeSessionResource(row);
  },

  /** 解除挂载(未归档门禁);File 本体不受影响,可被他处继续挂载 */
  async deleteSessionFileResource(
    env: Env,
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResourceDeletedResponse> {
    const db = getDb(env);
    const session = await findSession(db, sessionId);
    if (!session) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    assertSessionNotArchived(session.archivedAt);
    const deleted = await deleteSessionResourceRow(db, {
      sessionId,
      resourceId,
    });
    if (!deleted) {
      sessionResourceNotFound(resourceId);
    }
    return { id: resourceId, type: 'session_resource_deleted' };
  },

  // ---------- 事件运行时(docs/session/runtime.md;M0 起执行器为 null-turn) ----------

  /** 发送事件:404 → 已归档 409 → DO 追加并按需触发 turn(响应不等 turn 完成) */
  async sendEvents(
    env: Env,
    sessionId: string,
    events: EventInput[],
  ): Promise<{ data: PersistedEventJson[] }> {
    const row = await findSession(getDb(env), sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    assertSessionNotArchived(row.archivedAt);
    const raw = unwrapDoResult(await sessionDoStub(env, sessionId).sendEvents(events));
    return {
      data: raw.map((event) => JSON.parse(event) as PersistedEventJson),
    };
  },

  /** 分页读取事件历史(默认 100 条正序);过滤与游标解析在 handler */
  async listEvents(
    env: Env,
    sessionId: string,
    params: ListParams,
    filters: EventListFilters,
  ): Promise<Page<PersistedEventJson>> {
    const row = await findSession(getDb(env), sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    const cursorSeq = params.cursor === null ? undefined : cursorNumberField(params.cursor, 'seq');
    // listEvents 无失败分支(过滤参数已在传输层校验),结果无需解包
    const result = await sessionDoStub(env, sessionId).listEvents({
      filters,
      limit: params.limit,
      order: params.order,
      cursorSeq,
    });
    return {
      data: result.data.map((event) => JSON.parse(event) as PersistedEventJson),
      next_page:
        result.nextPageSeq === null
          ? null
          : encodeCursor({
              kind: SESSION_EVENTS_CURSOR_KIND,
              seq: result.nextPageSeq,
            }),
    };
  },

  /** SSE 订阅:只推连接后的新事件;重连协议 = 列表补历史 + 按 id 去重(runtime.md §7) */
  async streamEvents(
    env: Env,
    sessionId: string,
    deltas: DeltaEventType[],
  ): Promise<ReadableStream> {
    const row = await findSession(getDb(env), sessionId);
    if (!row) {
      throw notFoundError(`Session "${sessionId}" not found.`);
    }
    return unwrapDoResult(await sessionDoStub(env, sessionId).subscribe(deltas));
  },
};
