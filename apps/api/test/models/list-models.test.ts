/**
 * GET /v1/models 与动态目录拉取的测试。端点断言只针对静态目录部分——
 * 动态合并依赖外呼 Models API,在测试环境(伪凭据)必然走降级路径;
 * 合并/去重逻辑的纯函数覆盖在 packages/shared 的 models.test.ts。
 */
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authed } from "../helpers";
import { jsonBody } from "../sessions/helpers";
import { fetchDynamicModelNames, resetDynamicModelsCache } from "../../src/modules/model/models-api";
import type { ModelListResponse } from "@nano/shared";
import type { Env } from "../../src/env";

beforeAll(async () => {
  // 端点测试前清缓存:避免同 isolate 早先用例的上游结果串扰(此处必为降级)
  resetDynamicModelsCache();
});

describe("GET /v1/models", () => {
  it("返回静态目录条目,认证缺失 401", async () => {
    const res = await exports.default.fetch("http://example.com/v1/models", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<ModelListResponse>(res);
    expect(body.data).toContainEqual({
      id: "glm-5.3",
      label: "glm-5.3",
      wire_model: "@cf/zai-org/glm-5.3",
      source: "workers-ai",
      default_effort: "max",
    });
    expect(body.data).toContainEqual({
      id: "glm-5.3-flash",
      label: "glm-5.3-flash",
      wire_model: "@cf/zai-org/glm-5.3-flash",
      source: "workers-ai",
      default_effort: "high",
    });

    const unauthed = await exports.default.fetch("http://example.com/v1/models");
    expect(unauthed.status).toBe(401);
  });
});

describe("fetchDynamicModelNames(可注入 fetch)", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" } as unknown as Env;

  function jsonResponse(names: string[]): Response {
    return new Response(JSON.stringify({ result: names.map((name) => ({ name })) }), { status: 200 });
  }

  it("成功:解析 name 列表并缓存(第二次调用不再触网)", async () => {
    resetDynamicModelsCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(["@cf/zai-org/glm-5.2"]);
    }) as typeof fetch;
    expect(await fetchDynamicModelNames(env, fetchImpl)).toEqual(["@cf/zai-org/glm-5.2"]);
    expect(await fetchDynamicModelNames(env, fetchImpl)).toEqual(["@cf/zai-org/glm-5.2"]);
    expect(calls).toBe(1);
  });

  it("上游非 2xx / 网络异常:返回 null(降级不抛错)", async () => {
    resetDynamicModelsCache();
    const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    expect(await fetchDynamicModelNames(env, failing)).toBeNull();
    resetDynamicModelsCache();
    const throwing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await fetchDynamicModelNames(env, throwing)).toBeNull();
  });

  it("env 缺凭据:不发起请求直接 null", async () => {
    resetDynamicModelsCache();
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    expect(await fetchDynamicModelNames({} as Env, fetchImpl)).toBeNull();
  });
});
