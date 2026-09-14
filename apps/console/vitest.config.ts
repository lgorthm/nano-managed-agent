import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // wrangler.jsonc 的 services 绑定指向部署在 Cloudflare 上的 nano-api Worker,
      // 本地 workerd 没有同名服务会直接拒绝启动("refers to a service ... but no
      // such service is defined")。这里定义一个同名桩服务让绑定可解析;
      // 测试自行构造 env(含绑定实现),桩不会被调用,被调用即抛错。
      miniflare: {
        workers: [
          {
            name: "nano-api",
            modules: true,
            script:
              "export default { fetch() { throw new Error('stub nano-api must not be called'); } }",
          },
        ],
      },
    }),
  ],
});
