/**
 * Worker 绑定与请求上下文的类型。
 * 绑定类型由 `wrangler types` 从 wrangler.jsonc 生成的 worker-configuration.d.ts 提供,
 * 修改 wrangler.jsonc 后重跑 `pnpm types` 即可同步。
 * secret 与测试注入的变量不写入 wrangler.jsonc,在这里用声明合并补充进 Env:
 * - API_KEY / CLOUDFLARE_API_TOKEN:secret(wrangler secret put)
 * - AI_API_BASE:模型服务地址覆盖(可选,缺省由 CLOUDFLARE_ACCOUNT_ID 构造;测试注入 mock 地址)
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
      /** 模型服务凭据:具有 Workers AI Read 权限的 Cloudflare API Token */
      CLOUDFLARE_API_TOKEN: string;
      /** 模型服务地址覆盖:优先于 CLOUDFLARE_ACCOUNT_ID 构造的缺省值 */
      AI_API_BASE?: string;
      TURN_KEEPALIVE_INTERVAL_MS?: string;
      /** 测试注入:置 "1" 时工具执行走 mock 实现(沙箱进不了 vitest) */
      TOOL_SANDBOX_MOCK?: string;
    }
  }
}
