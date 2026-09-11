import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { buildUpstreamRequest, buildUpstreamUrl } from "../src/worker/proxy";

/** 开发旁路开启:Access 校验跳过,聚焦代理行为 */
const devEnv = {
  GLM_API_KEY: "test-key",
  CF_ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-aud",
  ACCESS_DEV_BYPASS: "1",
} as unknown as Env;

/** 生产语义:必须携带有效 Access JWT */
const prodEnv = {
  GLM_API_KEY: "test-key",
  CF_ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-aud",
} as unknown as Env;

/** 任何出网尝试都会让测试失败(用于断言"未出网"的场景) */
const noNetwork = (() => {
  throw new Error("unexpected outbound fetch");
}) satisfies typeof fetch;

describe("URL 改写", () => {
  it("/glm/<rest> 映射到 GLM API 并保留查询串", () => {
    const upstream = buildUpstreamUrl(new URL("http://localhost/glm/agent/managed/v1/agents?limit=5&order=desc"));
    expect(upstream.href).toBe("https://agent-api.bigmodel.cn/api/agent/managed/v1/agents?limit=5&order=desc");
  });
});

describe("上游请求构造", () => {
  it("注入鉴权与协议头,剔除本站 Cookie 与 CF 头", () => {
    const request = new Request("http://localhost/glm/agent/managed/v1/agents", {
      headers: {
        accept: "application/json",
        cookie: "CF_Authorization=secret; other=1",
        "cf-access-jwt-assertion": "jwt-value",
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    const upstream = buildUpstreamRequest(request, new URL(request.url), "test-key");

    expect(upstream.method).toBe("GET");
    expect(upstream.headers.get("authorization")).toBe("Bearer test-key");
    expect(upstream.headers.get("zai-version")).toBe("2026-05-26");
    expect(upstream.headers.get("zai-beta")).toBe("managed-agents-2026-05-26");
    expect(upstream.headers.get("accept")).toBe("application/json");
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(upstream.headers.get("cf-connecting-ip")).toBeNull();
    expect(upstream.headers.get("x-forwarded-for")).toBeNull();
  });

  it("透传 POST body 与 content-type", async () => {
    const request = new Request("http://localhost/glm/agent/managed/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "support-agent" }),
      headers: { "content-type": "application/json" },
    });
    const upstream = buildUpstreamRequest(request, new URL(request.url), "test-key");

    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    await expect(upstream.text()).resolves.toBe(JSON.stringify({ name: "support-agent" }));
  });
});

describe("handleRequest 路由与鉴权", () => {
  it("缺少 Access JWT 时返回 401 且不出网", async () => {
    const res = await handleRequest(
      new Request("http://localhost/glm/agent/managed/v1/agents"),
      prodEnv,
      noNetwork,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("unauthorized");
  });

  it("Access 配置仍是占位值时返回 503", async () => {
    const placeholderEnv = {
      GLM_API_KEY: "test-key",
      CF_ACCESS_TEAM_DOMAIN: "TODO-https://your-team.cloudflareaccess.com",
      CF_ACCESS_AUD: "TODO-access-aud-tag",
    } as unknown as Env;
    const res = await handleRequest(
      new Request("http://localhost/glm/agent/managed/v1/agents"),
      placeholderEnv,
      noNetwork,
    );
    expect(res.status).toBe(503);
  });

  it("非 /glm 路径返回 404(静态资源由平台接管)", async () => {
    const res = await handleRequest(new Request("http://localhost/assets/index.js"), devEnv, noNetwork);
    expect(res.status).toBe(404);
  });

  it("上游报错时原样返回状态与错误体", async () => {
    const upstreamError = new Response(
      JSON.stringify({
        type: "error",
        error: { type: "not_found_error", message: "agent not found" },
        request_id: "req_1",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
    const res = await handleRequest(
      new Request("http://localhost/glm/agent/managed/v1/agents/agent_404"),
      devEnv,
      () => Promise.resolve(upstreamError),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });

  it("响应剥离 set-cookie,保留 content-type", async () => {
    const upstreamOk = new Response(JSON.stringify({ data: [], next_page: null }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "acw_tc=server-side-junk; path=/",
      },
    });
    const res = await handleRequest(
      new Request("http://localhost/glm/agent/managed/v1/agents"),
      devEnv,
      () => Promise.resolve(upstreamOk),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("set-cookie")).toBeNull();
    await expect(res.json()).resolves.toEqual({ data: [], next_page: null });
  });
});
