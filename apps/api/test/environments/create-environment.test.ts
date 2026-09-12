import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  jsonBody,
  postEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
} from "./helpers";

beforeAll(applyMigrations);

const docExample = {
  name: "data-analysis-env",
  description: "数据分析沙箱：预装绘图与表格依赖",
  config: {
    type: "cloud",
    packages: {
      apt: ["poppler-utils"],
      pip: ["pandas", "matplotlib", "openpyxl"],
      npm: ["typescript"],
    },
    networking: { type: "unrestricted" },
  },
};

const EMPTY_PACKAGES = { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] };

describe("POST /v1/environments 成功路径", () => {
  it("文档示例创建成功,响应回显归一化后的完整配置", async () => {
    const res = await postEnvironment(docExample);
    expect(res.status).toBe(201);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.id).toMatch(/^env_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.type).toBe("environment");
    expect(body.name).toBe("data-analysis-env");
    expect(body.description).toBe("数据分析沙箱：预装绘图与表格依赖");
    expect(body.metadata).toEqual({});
    expect(body.config).toEqual({
      type: "cloud",
      packages: { ...EMPTY_PACKAGES, apt: ["poppler-utils"], npm: ["typescript"], pip: ["pandas", "matplotlib", "openpyxl"] },
      networking: { type: "unrestricted" },
    });
    expect(body.scope).toBe("organization");
    expect(body.state).toBe("active");
    expect(body.archived_at).toBeNull();
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.updated_at).toBe(body.created_at);
  });

  it("只提交 name,config 回显 cloud 默认形态", async () => {
    const res = await postEnvironment({ name: "default-env" });
    expect(res.status).toBe(201);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.config).toEqual({ type: "cloud", packages: EMPTY_PACKAGES, networking: { type: "unrestricted" } });
  });

  it("config 传 null 等价于默认;重复包名去重", async () => {
    const res = await postEnvironment({
      name: "dedupe-env",
      config: { type: "cloud", packages: { pip: ["a", "b", "a"] } },
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.config.packages.pip).toEqual(["a", "b"]);
  });

  it("limited 配置规范化回显:hosts 小写化排序去重,开关补全", async () => {
    const res = await postEnvironment({
      name: "limited-env",
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowed_hosts: ["Zulu.example.com", "alpha.example.com", "zulu.example.com"],
          allow_package_managers: true,
        },
      },
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.config.networking).toEqual({
      type: "limited",
      allowed_hosts: ["alpha.example.com", "zulu.example.com"],
      allow_package_managers: true,
      allow_mcp_servers: false,
    });
  });
});

describe("POST /v1/environments 校验失败返回 400", () => {
  async function expectInvalid(body: unknown, hint?: string) {
    const res = await postEnvironment(body);
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.type).toBe("error");
    expect(envelope.error.type).toBe("invalid_request_error");
    if (hint) {
      const issues = JSON.stringify(envelope.error.details?.issues ?? []);
      expect(issues).toContain(hint);
    }
    return envelope;
  }

  it("缺 name", async () => {
    await expectInvalid({ config: { type: "cloud" } });
  });

  it("name 超过 256 字符", async () => {
    await expectInvalid({ name: "a".repeat(257) });
  });

  it("description 超过 1024 字符", async () => {
    await expectInvalid({ ...docExample, description: "a".repeat(1025) });
  });

  it("metadata 超过 16 键", async () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    await expectInvalid({ ...docExample, metadata });
  });

  it("config.type 为 self_hosted 被拒绝", async () => {
    await expectInvalid({ name: "a", config: { type: "self_hosted" } });
  });

  it("config 内未知字段被拒绝", async () => {
    await expectInvalid({ name: "a", config: { type: "cloud", image: "ubuntu:24.04" } });
  });

  it("包名以 - 开头", async () => {
    await expectInvalid(
      { name: "a", config: { type: "cloud", packages: { pip: ["-flag"] } } },
      "must not start with '-'",
    );
  });

  it("包名含空白", async () => {
    await expectInvalid(
      { name: "a", config: { type: "cloud", packages: { pip: ["pandas >=2.0"] } } },
      "whitespace",
    );
  });

  it("allowed_hosts 写 https:// URL(带协议)", async () => {
    await expectInvalid(
      {
        name: "a",
        config: {
          type: "cloud",
          networking: { type: "limited", allowed_hosts: ["https://github.com"] },
        },
      },
      "invalid host",
    );
  });

  it("limited 声明 packages 但未显式放行包管理器联网", async () => {
    await expectInvalid(
      {
        name: "a",
        config: {
          type: "cloud",
          packages: { pip: ["requests"] },
          networking: { type: "limited", allowed_hosts: ["pypi.org"] },
        },
      },
      "allow_package_managers",
    );
  });

  it("unrestricted 携带 limited 专属字段", async () => {
    await expectInvalid({
      name: "a",
      config: { type: "cloud", networking: { type: "unrestricted", allowed_hosts: ["a.com"] } },
    });
  });

  it("未知顶层字段被拒绝", async () => {
    await expectInvalid({ ...docExample, extra: true });
  });

  it("请求体不是合法 JSON", async () => {
    const res = await postEnvironment("{not json");
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("invalid_request_error");
  });
});

describe("POST /v1/environments 认证", () => {
  it("不带凭证返回 401 错误信封", async () => {
    const res = await exports.default.fetch("http://example.com/v1/environments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-auth" }),
    });
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("authentication_error");
    expect(envelope.request_id).toMatch(/^req_/);
  });
});
