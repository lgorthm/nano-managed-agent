/**
 * Worker 绑定与请求上下文的类型。
 * 绑定类型由 `wrangler types` 从 wrangler.jsonc 生成的 worker-configuration.d.ts 提供,
 * 修改 wrangler.jsonc 后重跑 `pnpm types` 即可同步。
 * secret 与测试注入的变量不写入 wrangler.jsonc,在这里用声明合并补充进 Env:
 * - API_KEY / GLM_API_KEY:secret(wrangler secret put)
 * - TURN_KEEPALIVE_INTERVAL_MS:保活心跳间隔(可选,测试注入 2s,缺省 30s)
 */
export type Env = Cloudflare.Env;

/** request-id 中间件写入请求上下文的变量 */
export interface RequestVars {
  requestId: string;
}

/** Hono 应用的完整环境类型 */
export type AppEnv = { Bindings: Env; Variables: RequestVars };

declare global {
  namespace Cloudflare {
    interface Env {
      API_KEY: string;
      GLM_API_KEY: string;
      TURN_KEEPALIVE_INTERVAL_MS?: string;
    }
  }
}
