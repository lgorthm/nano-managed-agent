import {
  archiveEnvironment as archiveEnvironmentRow,
  createEnvironment as createEnvironmentRow,
  deleteEnvironment as deleteEnvironmentRow,
  findEnvironment,
  getDb,
  listEnvironmentsPage,
  newEnvironmentId,
  updateEnvironment as updateEnvironmentRow,
} from '@nano/db';
import type {
  EnvironmentCreateRequestInput,
  EnvironmentDeletedResponse,
  EnvironmentResponse,
  EnvironmentUpdateRequestInput,
  Page,
} from '@nano/shared';
import {
  environmentConfigIssues,
  environmentRecordEquals,
  mergeEnvironmentRecord,
  normalizeEnvironmentCreate,
} from '@nano/shared';
import type { Env } from '../../env';
import { invalidRequestError, notFoundError } from '../../lib/errors';
import {
  cursorNumberField,
  cursorStringField,
  encodeCursor,
  type ListParams,
} from '../../lib/pagination';
import { environmentRowToRecord, serializeEnvironment, serializeEnvironmentRow } from './serialize';

/** environments 列表游标的 kind 前缀,防止与其他列表端点的游标混用 */
const ENVIRONMENTS_CURSOR_KIND = 'environments';

/**
 * Environment 资源的业务编排层。
 * 单表无版本,判定链比 Agent 短一截——没有版本与 CAS,也就没有 409 路径。
 */
export const environmentService = {
  /** 创建:校验(handler 已完成)→ 归一化 → 生成 ID → 落库 → 以落库形态回显 */
  async createEnvironment(
    env: Env,
    input: EnvironmentCreateRequestInput,
  ): Promise<EnvironmentResponse> {
    const record = normalizeEnvironmentCreate(input);
    const id = newEnvironmentId();
    const now = new Date();
    await createEnvironmentRow(getDb(env), {
      id,
      name: record.name,
      description: record.description,
      config: record.config,
      metadata: record.metadata,
      now,
    });
    return serializeEnvironment({
      id,
      state: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      record,
    });
  },

  /** 获取完整环境;不存在时抛 404(归档的环境同样可读) */
  async getEnvironment(env: Env, environmentId: string): Promise<EnvironmentResponse> {
    const row = await findEnvironment(getDb(env), environmentId);
    if (!row) {
      throw notFoundError(`Environment "${environmentId}" not found.`);
    }
    return serializeEnvironmentRow(row);
  },

  /** 分页列出全部 Environment(含已归档),按 (created_at, id) keyset 排序 */
  async listEnvironments(env: Env, params: ListParams): Promise<Page<EnvironmentResponse>> {
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, 'createdAt'),
            id: cursorStringField(params.cursor, 'id'),
          };
    const { rows, nextCursor } = await listEnvironmentsPage(getDb(env), {
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map(serializeEnvironmentRow),
      next_page: nextCursor
        ? encodeCursor({
            kind: ENVIRONMENTS_CURSOR_KIND,
            createdAt: nextCursor.createdAt,
            id: nextCursor.id,
          })
        : null,
    };
  },

  /**
   * 更新,判定链(docs/environment/api/update-environment.md 的更新语义):
   * 取当前行(null → 404)→ 已归档拒绝(400)→ 合并补丁 → 联动校验作用于合并后的
   * 完整配置(400)→ 无变化直接返回现状(不写库)→ 就地覆盖(0 行受影响时重读区分 404/400)。
   */
  async updateEnvironment(
    env: Env,
    environmentId: string,
    patch: EnvironmentUpdateRequestInput,
  ): Promise<EnvironmentResponse> {
    const db = getDb(env);
    const current = await findEnvironment(db, environmentId);
    if (!current) {
      throw notFoundError(`Environment "${environmentId}" not found.`);
    }
    if (current.state !== 'active') {
      throw invalidRequestError('Environment is archived and cannot be updated.');
    }

    const currentRecord = environmentRowToRecord(current);
    const merged = mergeEnvironmentRecord(currentRecord, patch);

    const issues = environmentConfigIssues(merged.config);
    if (issues.length > 0) {
      throw invalidRequestError('Merged configuration is invalid.', {
        issues: issues.map((issue) => ({
          path: ['config', ...issue.path.map(String)].join('.'),
          message: issue.message,
        })),
      });
    }

    if (environmentRecordEquals(merged, currentRecord)) {
      return serializeEnvironmentRow(current);
    }

    const now = new Date();
    const updated = await updateEnvironmentRow(
      db,
      environmentId,
      {
        name: merged.name,
        description: merged.description,
        config: merged.config,
        metadata: merged.metadata,
      },
      now,
    );
    if (!updated) {
      // 读取之后行被删除或被归档;重读一次区分 404 与 400,不能笼统处理
      const row = await findEnvironment(db, environmentId);
      if (!row) {
        throw notFoundError(`Environment "${environmentId}" not found.`);
      }
      throw invalidRequestError('Environment is archived and cannot be updated.');
    }
    return serializeEnvironment({
      id: environmentId,
      state: 'active',
      createdAt: current.createdAt,
      updatedAt: now,
      archivedAt: null,
      record: merged,
    });
  },

  /**
   * 归档,幂等且不可逆:重复归档不改动数据,返回相同结果。
   * 归档后环境只读(更新被拒),读取与列表可见性保持不变;updated_at 不因归档变化。
   */
  async archiveEnvironment(env: Env, environmentId: string): Promise<EnvironmentResponse> {
    const db = getDb(env);
    let row = await findEnvironment(db, environmentId);
    if (!row) {
      throw notFoundError(`Environment "${environmentId}" not found.`);
    }
    if (row.state === 'active') {
      await archiveEnvironmentRow(db, environmentId, new Date());
      // 重新读取,回显库里真实状态(并发下他人先写入的归档时间也不会被覆盖)
      row = (await findEnvironment(db, environmentId)) ?? row;
    }
    return serializeEnvironmentRow(row);
  },

  /** 删除:硬终止,不做引用计数(与 GLM 一致);不存在时抛 404 */
  async deleteEnvironment(env: Env, environmentId: string): Promise<EnvironmentDeletedResponse> {
    const deleted = await deleteEnvironmentRow(getDb(env), environmentId);
    if (!deleted) {
      throw notFoundError(`Environment "${environmentId}" not found.`);
    }
    return { id: environmentId, type: 'environment_deleted' };
  },
};
