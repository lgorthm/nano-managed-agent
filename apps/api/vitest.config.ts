import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
// node 侧 mock 模型上游随配置加载启动(vitest.config 在 node 进程执行),
// 下面的 miniflare 绑定把 GLM_API_BASE 指向它;存活至 vitest 进程结束
import { startMockModelServer } from "./test/mock-model/server";

void startMockModelServer();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // 模型上游指向测试内的 mock SSE 服务(test/sessions/mock-model.ts),
      // 覆盖 wrangler vars 的生产默认值;保活间隔缩到 2s 让恢复巡检可等;
      // 工具执行走 mock 实现(沙箱依赖容器,进不了 vitest,runtime.md §9)
      miniflare: {
        bindings: {
          GLM_API_BASE: "http://127.0.0.1:18234",
          GLM_API_KEY: "test-model-key",
          TURN_KEEPALIVE_INTERVAL_MS: "2000",
          TOOL_SANDBOX_MOCK: "1",
        },
      },
    }),
  ],
  // 单测 5s 默认超时在慢环境(容器/共享 CI,单个 workerd 请求可达 ~2s)下会误杀
  // 多请求用例;断言不变,只放宽等待上限
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
