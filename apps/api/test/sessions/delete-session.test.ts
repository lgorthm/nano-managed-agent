import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveSessionViaApi,
  createDefaultFile,
  createDefaultSession,
  deleteSessionViaApi,
  getSession,
  jsonBody,
  postSession,
  setSessionStatusInDb,
  type SessionJson,
} from "./helpers";
import { createDefaultAgent, createDefaultEnvironment } from "./helpers";

beforeAll(applyMigrations);

describe("DELETE /v1/sessions/{sessionId}", () => {
  it("删除成功返回 {id, type:'session_deleted'},之后 GET 404、重复删除 404", async () => {
    const created = await createDefaultSession();
    const res = await deleteSessionViaApi(created.id);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ id: created.id, type: "session_deleted" });

    expect((await getSession(created.id)).status).toBe(404);
    expect((await deleteSessionViaApi(created.id)).status).toBe(404);
  });

  // 反直觉点②:已归档会话可以删除(归档不是"终态不可动")
  it("已归档会话允许删除", async () => {
    const created = await createDefaultSession();
    expect((await archiveSessionViaApi(created.id)).status).toBe(200);
    const res = await deleteSessionViaApi(created.id);
    expect(res.status).toBe(200);
    expect((await getSession(created.id)).status).toBe(404);
  });

  it("running 会话删除返回 409", async () => {
    const created = await createDefaultSession();
    await setSessionStatusInDb(created.id, "running");
    expect((await deleteSessionViaApi(created.id)).status).toBe(409);
  });

  it("删除级联清理挂载记录,File 本体不受影响", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const file = await createDefaultFile();
    const created = await jsonBody<SessionJson>(
      await postSession({
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: file.id }],
      }),
    );

    expect((await deleteSessionViaApi(created.id)).status).toBe(200);

    const mounts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM session_resources WHERE session_id = ?",
    )
      .bind(created.id)
      .first<{ n: number }>();
    expect(mounts?.n).toBe(0);

    // File 仍可读取(独立资源,不随会话删除)
    const { getFile } = await import("../files/helpers");
    expect((await getFile(file.id)).status).toBe(200);
  });

  it("不存在的 id 返回 404", async () => {
    expect((await deleteSessionViaApi("sess_00000000-0000-7000-8000-000000000000")).status).toBe(404);
  });
});
