import {
  archiveAgent as archiveAgentRow,
  createAgentWithFirstVersion,
  findAgentRow,
  findCurrentAgent,
  getDb,
  insertNextVersionAndAdvance,
  listAgentsPage,
  listAgentVersionsPage,
  newAgentId,
  type Db,
} from "@nano/db";
import type {
  AgentCreateRequestInput,
  AgentResponse,
  AgentUpdateRequestInput,
  Page,
} from "@nano/shared";
import { agentConfigIssues, normalizeAgentConfig } from "@nano/shared";
import type { Env } from "../../env";
import { conflictError, invalidRequestError, notFoundError } from "../../lib/errors";
import { cursorNumberField, cursorStringField, encodeCursor, type ListParams } from "../../lib/pagination";
import { assertSkillReferencesResolvable } from "../../lib/skill-refs";
import { mergeAgentConfig, agentConfigEquals } from "@nano/shared";
import { serializeAgent, serializeAgentRow, versionRowToConfig } from "./serialize";

/** agents 列表游标的 kind 前缀,防止与其他列表端点的游标混用 */
const AGENTS_CURSOR_KIND = "agents";

/** agent 版本列表游标的 kind 前缀 */
const AGENT_VERSIONS_CURSOR_KIND = "agent-versions";

/**
 * Agent 资源的业务编排层。
 * createAgent:校验(handler 已完成)→ 归一化 → 生成 ID → 落库 → 以落库形态回显。
 */
export const agentService = {
  async createAgent(env: Env, input: AgentCreateRequestInput): Promise<AgentResponse> {
    const config = normalizeAgentConfig(input);
    const db = getDb(env);
    await assertSkillReferencesResolvable(db, config.skills);
    const id = newAgentId();
    const now = new Date();
    await createAgentWithFirstVersion(db, { id, config, now });
    return serializeAgent({ id, version: 1, createdAt: now, updatedAt: now, archivedAt: null, config });
  },

  /** 获取当前版本及完整配置;不存在时抛 404 */
  async getAgent(env: Env, agentId: string): Promise<AgentResponse> {
    const current = await findCurrentAgent(getDb(env), agentId);
    if (!current) {
      throw notFoundError(`Agent "${agentId}" not found.`);
    }
    return serializeAgentRow(current.agent, current.version);
  },

  /** 分页列出全部 Agent(含已归档),按 (created_at, id) 排序 */
  async listAgents(env: Env, params: ListParams): Promise<Page<AgentResponse>> {
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, "createdAt"),
            id: cursorStringField(params.cursor, "id"),
          };
    const { rows, nextCursor } = await listAgentsPage(getDb(env), {
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map((row) => serializeAgentRow(row.agent, row.version)),
      next_page: nextCursor
        ? encodeCursor({ kind: AGENTS_CURSOR_KIND, createdAt: nextCursor.createdAt, id: nextCursor.id })
        : null,
    };
  },

  /**
   * 更新 Agent,判定链(docs/agent/api/update-agent.md 的更新语义):
   * 取当前版本(null → 404)→ 已归档拒绝(400)→ 合并补丁 → 合并结果做跨字段校验 →
   * 无变化直接返回现有版本(不写库)→ CAS 写入新版本(失败 → 409)。
   */
  async updateAgent(env: Env, agentId: string, patch: AgentUpdateRequestInput): Promise<AgentResponse> {
    const db = getDb(env);
    const current = await findCurrentAgent(db, agentId);
    if (!current) {
      throw notFoundError(`Agent "${agentId}" not found.`);
    }
    if (current.agent.archivedAt !== null) {
      throw invalidRequestError("Agent is archived and cannot be updated.");
    }

    const currentConfig = versionRowToConfig(current.version);
    const merged = mergeAgentConfig(currentConfig, patch);

    const issues = agentConfigIssues(merged);
    if (issues.length > 0) {
      throw invalidRequestError(
        "Merged configuration is invalid.",
        {
          issues: issues.map((issue) => ({
            path: issue.path.map(String).join(".") || "(root)",
            message: issue.message,
          })),
        },
      );
    }

    // 提交了 skills(含传 null 清空)才校验;未提交时保持现状,不必重查
    if (patch.skills !== undefined) {
      await assertSkillReferencesResolvable(db, merged.skills);
    }

    if (agentConfigEquals(merged, currentConfig)) {
      return serializeAgentRow(current.agent, current.version);
    }

    // 请求带 version 时以其为期望做 CAS;省略时以读到的当前值为期望(覆盖式更新,
    // 与读之间的并发写入仍会以 409 暴露,而不是静默丢更新)
    const expected = patch.version ?? current.agent.currentVersion;
    const now = new Date();
    const advanced = await insertNextVersionAndAdvance(db, {
      agentId,
      expectedVersion: expected,
      config: merged,
      now,
    });
    if (!advanced) {
      throw conflictError(
        `Version conflict: expected version ${expected}, but the agent has been modified concurrently.`,
      );
    }
    return serializeAgent({
      id: agentId,
      version: expected + 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      config: merged,
    });
  },

  /**
   * 分页列出指定 Agent 的历史版本,每条都是该版本的完整配置快照。
   * 时间戳语义(docs/agent/api/list-agent-versions.md):各版本用自身的时间戳,
   * archived_at 保持 Agent 级(同一 Agent 的所有条目回显同一个值)。
   */
  async listAgentVersions(env: Env, agentId: string, params: ListParams): Promise<Page<AgentResponse>> {
    const db = getDb(env);
    const agent = await findAgentRow(db, agentId);
    if (!agent) {
      throw notFoundError(`Agent "${agentId}" not found.`);
    }
    const cursor =
      params.cursor === null ? null : cursorNumberField(params.cursor, "version");
    const { rows, nextCursor } = await listAgentVersionsPage(db, agentId, {
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map((row) =>
        serializeAgent({
          id: agent.id,
          version: row.version,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          archivedAt: agent.archivedAt,
          config: versionRowToConfig(row),
        }),
      ),
      next_page:
        nextCursor === null
          ? null
          : encodeCursor({ kind: AGENT_VERSIONS_CURSOR_KIND, version: nextCursor }),
    };
  },

  /**
   * 归档 Agent,幂等:重复归档不改动数据,返回相同结果。
   * 归档后 Agent 只读(更新被拒),版本历史与列表可见性保持不变。
   */
  async archiveAgent(env: Env, agentId: string): Promise<AgentResponse> {
    const db = getDb(env);
    let current = await findCurrentAgent(db, agentId);
    if (!current) {
      throw notFoundError(`Agent "${agentId}" not found.`);
    }
    if (current.agent.archivedAt === null) {
      await archiveAgentRow(db, agentId, new Date());
      // 重新读取,回显库里真实状态(并发下他人先写入的 archived_at 也不会被覆盖)
      current = (await findCurrentAgent(db, agentId)) ?? current;
    }
    return serializeAgentRow(current.agent, current.version);
  },
};
