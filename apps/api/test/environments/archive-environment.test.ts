import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveEnvironmentViaApi,
  createDefaultEnvironment,
  getEnvironment,
  jsonBody,
  listEnvironments,
  updateEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
  type PageJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("POST /v1/environments/{environmentId}/archive", () => {
  it("归档后 state/archived_at 填充且后续获取不再变化", async () => {
    const created = await createDefaultEnvironment({ name: "archive-me" });
    const res = await archiveEnvironmentViaApi(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.state).toBe("archived");
    expect(body.archived_at).not.toBeNull();
    expect(body.id).toBe(created.id);

    const fetched = await jsonBody<EnvironmentJson>(await getEnvironment(created.id));
    expect(fetched.state).toBe("archived");
    expect(fetched.archived_at).toBe(body.archived_at);
  });

  it("重复归档返回相同结果(幂等)", async () => {
    const created = await createDefaultEnvironment();
    const first = await jsonBody<EnvironmentJson>(await archiveEnvironmentViaApi(created.id));
    const second = await jsonBody<EnvironmentJson>(await archiveEnvironmentViaApi(created.id));
    expect(second).toEqual(first);
  });

  it("归档不改变 updated_at", async () => {
    const created = await createDefaultEnvironment();
    const archived = await jsonBody<EnvironmentJson>(await archiveEnvironmentViaApi(created.id));
    expect(archived.updated_at).toBe(created.updated_at);
  });

  it("归档后仍出现在列表中(可见性不变)", async () => {
    const created = await createDefaultEnvironment({ name: "archived-listed" });
    await archiveEnvironmentViaApi(created.id);
    const page = await jsonBody<PageJson<EnvironmentJson>>(await listEnvironments("?limit=100&order=desc"));
    expect(page.data.some((item) => item.id === created.id)).toBe(true);
  });

  it("端到端回归:归档后调用更新接口返回 400", async () => {
    const created = await createDefaultEnvironment();
    await archiveEnvironmentViaApi(created.id);
    const res = await updateEnvironment(created.id, { description: "不该生效" });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.message).toContain("archived");
  });

  it("不存在的 id 返回 404", async () => {
    const res = await archiveEnvironmentViaApi("env_01911111-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("not_found_error");
  });

  it("不带凭证返回 401", async () => {
    const { exports } = await import("cloudflare:workers");
    const created = await createDefaultEnvironment();
    const res = await exports.default.fetch(
      `http://example.com/v1/environments/${encodeURIComponent(created.id)}/archive`,
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });
});
