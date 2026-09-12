import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveEnvironmentViaApi,
  createDefaultEnvironment,
  deleteEnvironmentViaApi,
  getEnvironment,
  jsonBody,
  listEnvironments,
  updateEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
  type PageJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("DELETE /v1/environments/{environmentId}", () => {
  it("删除成功返回 environment_deleted 回执", async () => {
    const created = await createDefaultEnvironment({ name: "delete-me" });
    const res = await deleteEnvironmentViaApi(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ id: string; type: string }>(res);
    expect(body).toEqual({ id: created.id, type: "environment_deleted" });
  });

  it("删除后再 get / 更新 / 归档均 404,列表不再出现", async () => {
    const created = await createDefaultEnvironment();
    await deleteEnvironmentViaApi(created.id);

    expect((await getEnvironment(created.id)).status).toBe(404);
    expect((await updateEnvironment(created.id, { description: "x" })).status).toBe(404);
    expect((await archiveEnvironmentViaApi(created.id)).status).toBe(404);

    const page = await jsonBody<PageJson<EnvironmentJson>>(await listEnvironments("?limit=100&order=desc"));
    expect(page.data.some((item) => item.id === created.id)).toBe(false);
  });

  it("归档后的环境仍可删除", async () => {
    const created = await createDefaultEnvironment({ name: "archived-then-deleted" });
    const archived = await jsonBody<EnvironmentJson>(await archiveEnvironmentViaApi(created.id));
    expect(archived.state).toBe("archived");
    const res = await deleteEnvironmentViaApi(created.id);
    expect(res.status).toBe(200);
    expect((await getEnvironment(created.id)).status).toBe(404);
  });

  it("重复删除同一 id 返回 404", async () => {
    const created = await createDefaultEnvironment();
    expect((await deleteEnvironmentViaApi(created.id)).status).toBe(200);
    const res = await deleteEnvironmentViaApi(created.id);
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("not_found_error");
  });

  it("不存在的 id 返回 404 完整错误信封", async () => {
    const res = await deleteEnvironmentViaApi("env_01911111-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.type).toBe("error");
    expect(envelope.request_id).toMatch(/^req_/);
  });

  it("不带凭证返回 401", async () => {
    const created = await createDefaultEnvironment();
    const res = await exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("authentication_error");
  });
});
