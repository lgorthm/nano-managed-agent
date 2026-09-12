import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveSessionViaApi,
  createDefaultSession,
  getSession,
  jsonBody,
  listSessions,
  setSessionStatusInDb,
  updateSession,
  type ErrorEnvelope,
  type PageJson,
  type SessionJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("POST /v1/sessions/{sessionId}/archive", () => {
  it("归档成功,archived_at 填充且后续获取不再变化", async () => {
    const created = await createDefaultSession();
    const res = await archiveSessionViaApi(created.id);
    expect(res.status).toBe(200);
    const archived = await jsonBody<SessionJson>(res);
    expect(archived.archived_at).not.toBeNull();
    expect(archived.id).toBe(created.id);

    const reread = await jsonBody<SessionJson>(await getSession(created.id));
    expect(reread.archived_at).toBe(archived.archived_at);
  });

  // 反直觉点①:与 agent/environment 的幂等归档相反,GLM session 重复归档是 409
  it("重复归档返回 409 session_archived(非幂等,与 Agent 归档行为相反)", async () => {
    const created = await createDefaultSession();
    expect((await archiveSessionViaApi(created.id)).status).toBe(200);

    const repeat = await archiveSessionViaApi(created.id);
    expect(repeat.status).toBe(409);
    const error = await jsonBody<ErrorEnvelope>(repeat);
    expect(error.error.message).toContain("session_archived");
  });

  it("running 会话归档返回 409", async () => {
    const created = await createDefaultSession();
    await setSessionStatusInDb(created.id, "running");
    const res = await archiveSessionViaApi(created.id);
    expect(res.status).toBe(409);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("running");
  });

  it("归档后:列表默认不出现、include_archived=true 出现、更新被拒(端到端回归)", async () => {
    const created = await createDefaultSession();
    expect((await archiveSessionViaApi(created.id)).status).toBe(200);

    const hiddenRes = await listSessions(`?agent_id=${created.agent.id}&limit=100`);
    const hidden = await jsonBody<PageJson<SessionJson>>(hiddenRes);
    expect(hidden.data.map((row) => row.id)).not.toContain(created.id);

    const visibleRes = await listSessions(`?agent_id=${created.agent.id}&limit=100&include_archived=true`);
    const visible = await jsonBody<PageJson<SessionJson>>(visibleRes);
    expect(visible.data.map((row) => row.id)).toContain(created.id);

    const update = await updateSession(created.id, { title: "nope" });
    expect(update.status).toBe(409);
  });

  it("不存在的 id 返回 404", async () => {
    expect((await archiveSessionViaApi("sess_00000000-0000-7000-8000-000000000000")).status).toBe(404);
  });
});
