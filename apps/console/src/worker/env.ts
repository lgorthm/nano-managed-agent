/**
 * Worker 绑定与环境变量的类型。
 * CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD 来自 wrangler.jsonc vars,
 * 由 `wrangler types` 生成进 worker-configuration.d.ts;
 * GLM_API_KEY(secret)与 ACCESS_DEV_BYPASS(仅 .dev.vars)不经过 wrangler.jsonc,
 * 在这里声明。注意:`wrangler types` 也会把 .dev.vars 的键以必填 string 写入
 * 生成文件,所以这里保持必填 string,两侧类型才能合并;
 * ACCESS_DEV_BYPASS 运行时可能不存在,代码里按值判断(=== "1")。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      GLM_API_KEY: string;
      /** 仅限本地 .dev.vars:"1" 时跳过 Access JWT 校验;生产严禁配置 */
      ACCESS_DEV_BYPASS: string;
    }
  }
}

export type Env = Cloudflare.Env;
