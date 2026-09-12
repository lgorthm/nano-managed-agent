import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveSessionInDb,
  createDefaultFile,
  createDefaultSession,
  getSession,
  jsonBody,
  postSession,
  type ErrorEnvelope,
  type SessionJson,
} from "./helpers";
import { createDefaultAgent, createDefaultEnvironment } from "./helpers";

beforeAll(applyMigrations);

describe("GET /v1/sessions/{sessionId}", () => {
  it("创建后按 id 获取,字段与创建响应完全一致", async () => {
    const created = await createDefaultSession();
    const res = await getSession(created.id);
    expect(res.status).toBe(200);
    expect(await jsonBody<SessionJson>(res)).toEqual(created);
  });

  it("挂载了资源的会话 resources 数组完整回显", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const file = await createDefaultFile();
    const created = await jsonBody<SessionJson>(
      await postSession({
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: file.id, mount_path: "docs/readme.md" }],
      }),
    );
    const res = await getSession(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<SessionJson>(res);
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]?.mount_path).toBe("/mnt/session/uploads/docs/readme.md");
    expect(body.resources[0]?.file_id).toBe(file.id);
  });

  it("归档后的会话(直改库)仍可读取,archived_at 非空", async () => {
    const created = await createDefaultSession();
    await archiveSessionInDb(created.id);
    const res = await getSession(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<SessionJson>(res);
    expect(body.archived_at).not.toBeNull();
    expect(body.status).toBe("idle");
  });

  it("不存在的 id 返回 404 且是完整错误信封;任意合法字符串不 500", async () => {
    for (const id of ["sess_00000000-0000-7000-8000-000000000000", "not-a-session"]) {
      const res = await getSession(id);
      expect(res.status).toBe(404);
      const error = await jsonBody<ErrorEnvelope>(res);
      expect(error.type).toBe("error");
      expect(error.error.type).toBe("not_found_error");
      expect(error.request_id).toMatch(/^req_/);
    }
  });

  it("不带凭证返回 401", async () => {
    const res = await getSession("sess_x", { Authorization: "" });
    expect(res.status).toBe(401);
  });
});
