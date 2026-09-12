import { describe, expect, it } from "vitest";
import { EnvironmentCreateRequestSchema, EnvironmentUpdateRequestSchema, environmentConfigIssues } from "../../src";

/** 创建请求的合法最小载体 */
const base = { name: "test-env" };

function parseCreate(body: unknown) {
  return EnvironmentCreateRequestSchema.safeParse(body);
}

/** 包一层 config 再走创建请求校验 */
function withConfig(config: unknown) {
  return parseCreate({ ...base, config });
}

describe("EnvironmentCreateRequestSchema 基础校验", () => {
  it("只提交 name 即合法", () => {
    const result = parseCreate(base);
    expect(result.success).toBe(true);
  });

  it("缺 name 或 name 为空串被拒绝", () => {
    expect(parseCreate({}).success).toBe(false);
    expect(parseCreate({ name: "" }).success).toBe(false);
  });

  it("name 超过 256 字符被拒绝", () => {
    expect(parseCreate({ ...base, name: "a".repeat(257) }).success).toBe(false);
  });

  it("description 超过 1024 字符被拒绝,null 合法", () => {
    expect(parseCreate({ ...base, description: "a".repeat(1025) }).success).toBe(false);
    expect(parseCreate({ ...base, description: null }).success).toBe(true);
  });

  it("metadata 超过 16 键被拒绝", () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    expect(parseCreate({ ...base, metadata }).success).toBe(false);
  });

  it("scope 只接受 organization(可 null)", () => {
    expect(parseCreate({ ...base, scope: "organization" }).success).toBe(true);
    expect(parseCreate({ ...base, scope: null }).success).toBe(true);
    expect(parseCreate({ ...base, scope: "personal" }).success).toBe(false);
  });

  it("未知顶层字段被拒绝(strict)", () => {
    expect(parseCreate({ ...base, extra: true }).success).toBe(false);
  });
});

describe("config 校验", () => {
  it("config 省略或 null 合法;type 缺失被拒绝", () => {
    expect(withConfig(undefined).success).toBe(true);
    expect(withConfig(null).success).toBe(true);
    expect(withConfig({ packages: { pip: ["requests"] } }).success).toBe(false);
  });

  it("type 仅接受 cloud,self_hosted 被拒绝", () => {
    expect(withConfig({ type: "cloud" }).success).toBe(true);
    expect(withConfig({ type: "self_hosted" }).success).toBe(false);
  });

  it("config 内未知字段被拒绝", () => {
    expect(withConfig({ type: "cloud", image: "ubuntu:24.04" }).success).toBe(false);
  });

  it("packages 内未知字段(自定义 registry 配置)被拒绝", () => {
    expect(
      withConfig({ type: "cloud", packages: { pip: ["requests"], index_url: "https://pypi.example.com" } }).success,
    ).toBe(false);
  });

  it("packages 可带可选判别字段 type=packages", () => {
    expect(withConfig({ type: "cloud", packages: { type: "packages", pip: ["requests"] } }).success).toBe(true);
    expect(withConfig({ type: "cloud", packages: { type: "packages" } }).success).toBe(true);
  });
});

describe("包名校验", () => {
  const withPip = (pip: unknown) => withConfig({ type: "cloud", packages: { pip } });

  it("合法包名通过", () => {
    expect(withPip(["pandas", "matplotlib", "openpyxl"]).success).toBe(true);
    expect(withPip(["python-3.13", "typing_extensions"]).success).toBe(true);
  });

  it("以 - 开头被拒绝", () => {
    expect(withPip(["-flag"]).success).toBe(false);
  });

  it("含空白被拒绝", () => {
    expect(withPip(["pandas >=2.0"]).success).toBe(false);
  });

  it("含控制字符被拒绝", () => {
    expect(withPip(["pandas\n"]).success).toBe(false);
    expect(withPip(["pandas\u0000"]).success).toBe(false);
  });

  it("空串或纯空白被拒绝", () => {
    expect(withPip([""]).success).toBe(false);
    expect(withPip(["   "]).success).toBe(false);
  });

  it("超过 256 字符被拒绝", () => {
    expect(withPip(["a".repeat(257)]).success).toBe(false);
  });

  it("单管理器超过 200 项被拒绝,null 合法", () => {
    expect(withPip(Array.from({ length: 201 }, (_, i) => `p${i}`)).success).toBe(false);
    expect(withPip(null).success).toBe(true);
  });
});

describe("网络策略校验", () => {
  const withNetworking = (networking: unknown) => withConfig({ type: "cloud", networking });

  it("unrestricted 与 limited 的基本形态合法", () => {
    expect(withNetworking({ type: "unrestricted" }).success).toBe(true);
    expect(
      withNetworking({ type: "limited", allowed_hosts: ["api.example.com"], allow_package_managers: true }).success,
    ).toBe(true);
  });

  it("unrestricted 携带 limited 专属字段被拒绝", () => {
    expect(withNetworking({ type: "unrestricted", allowed_hosts: ["a.com"] }).success).toBe(false);
    expect(withNetworking({ type: "unrestricted", allow_mcp_servers: false }).success).toBe(false);
  });

  it("未知 type 与未知字段被拒绝", () => {
    expect(withNetworking({ type: "custom" }).success).toBe(false);
    expect(withNetworking({ type: "limited", extra: true }).success).toBe(false);
  });

  it("allowed_hosts 带协议 / 端口 / 路径被拒绝", () => {
    expect(withNetworking({ type: "limited", allowed_hosts: ["https://api.example.com"] }).success).toBe(false);
    expect(withNetworking({ type: "limited", allowed_hosts: ["api.example.com:8080"] }).success).toBe(false);
    expect(withNetworking({ type: "limited", allowed_hosts: ["api.example.com/v1"] }).success).toBe(false);
  });

  it("通配只接受 *. 前缀的整标签形式", () => {
    expect(withNetworking({ type: "limited", allowed_hosts: ["*.example.com"] }).success).toBe(true);
    expect(withNetworking({ type: "limited", allowed_hosts: ["*example.com"] }).success).toBe(false);
    expect(withNetworking({ type: "limited", allowed_hosts: ["*"] }).success).toBe(false);
  });

  it("非 ASCII 主机名被拒绝(不做 punycode)", () => {
    expect(withNetworking({ type: "limited", allowed_hosts: ["例え.jp"] }).success).toBe(false);
  });

  it("非法标签形态被拒绝", () => {
    expect(withNetworking({ type: "limited", allowed_hosts: ["-bad.example.com"] }).success).toBe(false);
    expect(withNetworking({ type: "limited", allowed_hosts: ["bad-.example.com"] }).success).toBe(false);
    expect(withNetworking({ type: "limited", allowed_hosts: ["api..com"] }).success).toBe(false);
  });

  it("allowed_hosts 超 255 字符或超过 256 项被拒绝", () => {
    expect(
      withNetworking({
        type: "limited",
        allowed_hosts: [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: 257 }, (_, i) => `h${i}.example.com`);
    expect(withNetworking({ type: "limited", allowed_hosts: many }).success).toBe(false);
  });
});

describe("limited 与 packages 的联动校验", () => {
  it("limited 且声明 packages 但未显式放行,创建请求被拒绝", () => {
    const result = parseCreate({
      ...base,
      config: {
        type: "cloud",
        packages: { pip: ["requests"] },
        networking: { type: "limited", allowed_hosts: ["pypi.org"] },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("allow_package_managers");
    }
  });

  it("limited 且显式 allow_package_managers=true 通过", () => {
    expect(
      parseCreate({
        ...base,
        config: {
          type: "cloud",
          packages: { pip: ["requests"] },
          networking: { type: "limited", allowed_hosts: ["pypi.org"], allow_package_managers: true },
        },
      }).success,
    ).toBe(true);
  });

  it("limited 且 packages 为空(null)时无需放行", () => {
    expect(
      parseCreate({
        ...base,
        config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.example.com"] } },
      }).success,
    ).toBe(true);
  });

  it("environmentConfigIssues 直接对输入形态生效(undefined 开关视为未放行)", () => {
    const issues = environmentConfigIssues({
      packages: { pip: ["requests"] },
      networking: { type: "limited" },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["networking", "allow_package_managers"]);
  });
});

describe("EnvironmentUpdateRequestSchema", () => {
  it("空对象是合法空补丁", () => {
    expect(EnvironmentUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it("config 可为 null(恢复默认),config.type 仍必填", () => {
    expect(EnvironmentUpdateRequestSchema.safeParse({ config: null }).success).toBe(true);
    expect(EnvironmentUpdateRequestSchema.safeParse({ config: { packages: { pip: ["x"] } } }).success).toBe(false);
    expect(EnvironmentUpdateRequestSchema.safeParse({ config: { type: "cloud" } }).success).toBe(true);
  });

  it("name 不可传 null;description 可为 null", () => {
    expect(EnvironmentUpdateRequestSchema.safeParse({ name: null }).success).toBe(false);
    expect(EnvironmentUpdateRequestSchema.safeParse({ description: null }).success).toBe(true);
  });

  it("未知字段被拒绝(strict,含 version)", () => {
    expect(EnvironmentUpdateRequestSchema.safeParse({ version: 1 }).success).toBe(false);
  });
});
