import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveEnvironmentInDb,
  createDefaultEnvironment,
  jsonBody,
  postEnvironment,
  updateEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
} from "./helpers";

beforeAll(applyMigrations);

const EMPTY_PACKAGES = { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] };

/** 创建一个带多管理器包与 unrestricted 网络的环境,作为更新的基线 */
async function createBaseline(): Promise<EnvironmentJson> {
  const res = await postEnvironment({
    name: "update-baseline",
    description: "初始说明",
    metadata: { team: "infra", env: "prod" },
    config: {
      type: "cloud",
      packages: { apt: ["poppler-utils"], pip: ["pandas"], npm: ["typescript"] },
      networking: { type: "unrestricted" },
    },
  });
  return jsonBody<EnvironmentJson>(res);
}

describe("POST /v1/environments/{environmentId} 更新语义", () => {
  it("只改 description 其余不变", async () => {
    const created = await createBaseline();
    const res = await updateEnvironment(created.id, { description: "新说明" });
    expect(res.status).toBe(200);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.description).toBe("新说明");
    expect(body.name).toBe("update-baseline");
    expect(body.config).toEqual(created.config);
    expect(body.metadata).toEqual(created.metadata);
    expect(body.created_at).toBe(created.created_at);
    expect(body.updated_at >= created.updated_at).toBe(true);
  });

  it("config 整体替换:未提及的管理器列表清空,hosts 规范化回显", async () => {
    const created = await createBaseline();
    const res = await updateEnvironment(created.id, {
      config: {
        type: "cloud",
        packages: { pip: ["requests"] },
        networking: {
          type: "limited",
          allowed_hosts: ["B.example.com", "a.example.com", "b.example.com"],
          allow_package_managers: true,
        },
      },
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.config.packages).toEqual({ ...EMPTY_PACKAGES, pip: ["requests"] });
    expect(body.config.networking).toEqual({
      type: "limited",
      allowed_hosts: ["a.example.com", "b.example.com"],
      allow_package_managers: true,
      allow_mcp_servers: false,
    });
  });

  it("config 传 null 恢复 cloud 默认配置", async () => {
    const created = await createBaseline();
    const res = await updateEnvironment(created.id, { config: null });
    expect(res.status).toBe(200);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.config).toEqual({ type: "cloud", packages: EMPTY_PACKAGES, networking: { type: "unrestricted" } });
  });

  it("description 传 null 清空", async () => {
    const created = await createBaseline();
    const res = await updateEnvironment(created.id, { description: null });
    expect((await jsonBody<EnvironmentJson>(res)).description).toBeNull();
  });

  it("metadata 按键合并与删键", async () => {
    const created = await createBaseline();
    const res = await updateEnvironment(created.id, { metadata: { team: "data", tier: "gold", env: null } });
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.metadata).toEqual({ team: "data", tier: "gold" });
  });

  it("空请求体与空对象是合法空补丁,无变化不写库", async () => {
    const created = await createBaseline();
    for (const body of [null, {}] as const) {
      const res = await updateEnvironment(created.id, body);
      expect(res.status).toBe(200);
      const result = await jsonBody<EnvironmentJson>(res);
      expect(result.updated_at).toBe(created.updated_at);
    }
  });

  it("提交与当前完全相同的配置不写库、updated_at 不变", async () => {
    const created = await createBaseline();
    // 先做一次真实更新让 updated_at 前移,再提交等价配置验证无变化检测
    const first = await jsonBody<EnvironmentJson>(await updateEnvironment(created.id, { description: "第一次" }));
    const second = await jsonBody<EnvironmentJson>(
      await updateEnvironment(created.id, {
        description: "第一次",
        config: {
          type: "cloud",
          packages: { apt: ["poppler-utils"], pip: ["pandas"], npm: ["typescript"] },
          networking: { type: "unrestricted" },
        },
      }),
    );
    expect(second.updated_at).toBe(first.updated_at);
  });

  it("空请求体本身不是合法 JSON 时返回 400(脏 body)", async () => {
    const created = await createDefaultEnvironment();
    const res = await updateEnvironment(created.id, "{not json");
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/environments/{environmentId} 校验失败返回 400", () => {
  it("替换 config 声明 packages 且切 limited 未放行", async () => {
    const created = await createDefaultEnvironment();
    const res = await updateEnvironment(created.id, {
      config: {
        type: "cloud",
        packages: { pip: ["requests"] },
        networking: { type: "limited", allowed_hosts: ["pypi.org"] },
      },
    });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(JSON.stringify(envelope.error.details?.issues ?? [])).toContain("allow_package_managers");
  });

  it("显式 allow_package_managers=true 成功", async () => {
    const created = await createDefaultEnvironment();
    const res = await updateEnvironment(created.id, {
      config: {
        type: "cloud",
        packages: { pip: ["requests"] },
        networking: { type: "limited", allowed_hosts: ["pypi.org"], allow_package_managers: true },
      },
    });
    expect(res.status).toBe(200);
  });

  it("config 缺 type 被拒绝", async () => {
    const created = await createDefaultEnvironment();
    const res = await updateEnvironment(created.id, { config: { packages: { pip: ["x"] } } });
    expect(res.status).toBe(400);
  });

  it("已归档环境更新返回 400", async () => {
    const created = await createDefaultEnvironment();
    await archiveEnvironmentInDb(created.id);
    const res = await updateEnvironment(created.id, { description: "不该生效" });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.message).toContain("archived");
  });
});

describe("POST /v1/environments/{environmentId} 404 与 401", () => {
  it("不存在的 id 返回 404", async () => {
    const res = await updateEnvironment("env_01911111-0000-7000-8000-000000000000", { description: "x" });
    expect(res.status).toBe(404);
  });

  it("不带凭证返回 401", async () => {
    const { exports } = await import("cloudflare:workers");
    const created = await createDefaultEnvironment();
    const res = await exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(401);
  });
});
