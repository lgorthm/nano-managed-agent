import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  // 单测 5s 默认超时在慢环境(容器/共享 CI,单个 workerd 请求可达 ~2s)下会误杀
  // 多请求用例;断言不变,只放宽等待上限
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
