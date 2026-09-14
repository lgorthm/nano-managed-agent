import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { buildNanoUpstreamUrl, buildUpstreamRequest, buildUpstreamUrl } from "../src/worker/proxy";

/** 开发旁路开启:Access 校验跳过,聚焦代理行为 */
const devEnv = {
  GLM_API_KEY: "test-key",
  NANO_API_BASE: "http://127.0.0.1:8787",
  NANO_API_KEY: "nano-key",
  CF_ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-aud",
  ACCESS_DEV_BYPASS: "1",
} as unknown as Env;

/** 生产语义:必须携带有效 Access JWT */
const prodEnv = {
  GLM_API_KEY: "test-key",
  NANO_API_KEY: "nano-key",
  CF_ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-aud",
} as unknown as Env;

/** 任何出网尝试都会让测试失败(用于断言"未出网"的场景) */
const noNetwork = (() => {
  throw new Error("unexpected outbound fetch");
}) satisfies typeof fetch;

/** 记录发往上游的请求,供断言 URL 与请求头 */
function fetchCapturing(response: Response, captured: Request[]): typeof fetch {
  return (input) => {
    captured.push(input as Request);
    return Promise.resolve(response);
  };
}

describe("URL 改写", () => {
  it("/glm/<rest> 映射到 GLM API 并保留查询串", () => {
    const upstream = buildUpstreamUrl(new URL("http://localhost/glm/agent/managed/v1/agents?limit=5&order=desc"));
    expect(upstream.href).toBe("https://agent-api.bigmodel.cn/api/agent/managed/v1/agents?limit=5&order=desc");
  });

  it("/nano/agent/managed/v1/<rest> 映射到 nano 上游的 /v1/<rest>", () => {
    const upstream = buildNanoUpstreamUrl(
      new URL("http://localhost/nano/agent/managed/v1/agents?limit=5&order=desc"),
      "http://127.0.0.1:8787",
    );
    expect(upstream.href).toBe("http://127.0.0.1:8787/v1/agents?limit=5&order=desc");
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
    const upstream = buildUpstreamRequest(request, buildUpstreamUrl(new URL(request.url)), "test-key");

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
    const upstream = buildUpstreamRequest(request, buildUpstreamUrl(new URL(request.url)), "test-key");

    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    await expect(upstream.text()).resolves.toBe(JSON.stringify({ name: "support-agent" }));
  });

  it("zaiProtocol=false 时不注入 zai 协议头(nano 分支)", () => {
    const request = new Request("http://localhost/nano/agent/managed/v1/agents");
    const upstream = buildUpstreamRequest(
      request,
      buildNanoUpstreamUrl(new URL(request.url), "http://127.0.0.1:8787"),
      "nano-key",
      false,
    );

    expect(upstream.url).toBe("http://127.0.0.1:8787/v1/agents");
    expect(upstream.headers.get("authorization")).toBe("Bearer nano-key");
    expect(upstream.headers.get("zai-version")).toBeNull();
    expect(upstream.headers.get("zai-beta")).toBeNull();
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

  it("/nano 分支同样要求 Access JWT", async () => {
    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/agents"),
      prodEnv,
      noNetwork,
    );
    expect(res.status).toBe(401);
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

  it("非 /glm 与 /nano 路径返回 404(静态资源由平台接管)", async () => {
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

describe("nano 分支", () => {
  it("/nano/* 转发到 nano 上游:改写 /v1 路径、换 NANO_API_KEY、不带 zai 头", async () => {
    const captured: Request[] = [];
    const upstreamOk = new Response(JSON.stringify({ data: [], next_page: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/agents?limit=5"),
      devEnv,
      fetchCapturing(upstreamOk, captured),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const upstream = captured[0]!;
    expect(upstream.url).toBe("http://127.0.0.1:8787/v1/agents?limit=5");
    expect(upstream.headers.get("authorization")).toBe("Bearer nano-key");
    expect(upstream.headers.get("zai-version")).toBeNull();
    expect(upstream.headers.get("zai-beta")).toBeNull();
  });

  it("配置了 NANO_API_SERVICE 绑定时经绑定出网,不走普通 fetch(生产同账号直连通道)", async () => {
    const captured: Request[] = [];
    const bindingEnv = {
      ...devEnv,
      NANO_API_SERVICE: {
        fetch: (input: RequestInfo) => {
          captured.push(input as Request);
          return Promise.resolve(
            new Response(JSON.stringify({ data: [], next_page: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    } as unknown as Env;

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/agents?limit=5"),
      bindingEnv,
      noNetwork,
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("http://127.0.0.1:8787/v1/agents?limit=5");
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer nano-key");
    await expect(res.json()).resolves.toEqual({ data: [], next_page: null });
  });

  it("files 列表:after_id 映射为 page,响应适配出 has_more/first_id/last_id", async () => {
    const captured: Request[] = [];
    const upstreamPage = new Response(
      JSON.stringify({ data: [{ id: "file_2" }], next_page: "eyJraW5kIjoiZmlsZXMifQ" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/files?limit=20&after_id=file_9"),
      devEnv,
      fetchCapturing(upstreamPage, captured),
    );
    expect(captured[0]!.url).toBe("http://127.0.0.1:8787/v1/files?limit=20&page=file_9");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({
      data: [{ id: "file_2" }],
      has_more: true,
      first_id: "file_2",
      last_id: "eyJraW5kIjoiZmlsZXMifQ",
    });
  });

  it("files 列表末页:next_page 为 null 时 has_more 为 false、last_id 为 null", async () => {
    const upstreamPage = new Response(JSON.stringify({ data: [{ id: "file_1" }], next_page: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/files"),
      devEnv,
      () => Promise.resolve(upstreamPage),
    );
    await expect(res.json()).resolves.toEqual({
      data: [{ id: "file_1" }],
      has_more: false,
      first_id: "file_1",
      last_id: null,
    });
  });

  it("files 列表报错时错误信封原样透传,不做适配", async () => {
    const upstreamError = new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid page cursor." } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/files"),
      devEnv,
      () => Promise.resolve(upstreamError),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("files 详情等非列表端点原样透传,不触碰查询串", async () => {
    const captured: Request[] = [];
    const upstreamFile = new Response(JSON.stringify({ id: "file_1", filename: "a.txt" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const res = await handleRequest(
      new Request("http://localhost/nano/agent/managed/v1/files/file_1"),
      devEnv,
      fetchCapturing(upstreamFile, captured),
    );
    expect(captured[0]!.url).toBe("http://127.0.0.1:8787/v1/files/file_1");
    await expect(res.json()).resolves.toEqual({ id: "file_1", filename: "a.txt" });
  });
});
