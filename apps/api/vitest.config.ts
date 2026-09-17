import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
// 测试鉴权键与用例侧常量同源:CI 上没有 .dev.vars(不入库),被测 Worker
// 的 API_KEY 必须由这里注入,否则所有鉴权用例 500
import { API_KEY } from './test/helpers';
// node 侧 mock 模型上游随配置加载启动(vitest.config 在 node 进程执行),
// 下面的 miniflare 绑定把 AI_API_BASE 指向它;存活至 vitest 进程结束
import { startMockModelServer } from './test/mock-model/server';

void startMockModelServer();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // 模型上游(AI Gateway REST API 的 chat completions 端点)指向测试内的
      // mock SSE 服务,覆盖 wrangler vars 的生产默认值;保活间隔缩到 2s 让恢复
      // 巡检可等;工具执行走 mock 实现(沙箱依赖容器,进不了 vitest,runtime.md §9)
      miniflare: {
        bindings: {
          API_KEY,
          AI_API_BASE: 'http://127.0.0.1:18234',
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          AI_GATEWAY_ID: 'test-gateway',
          CLOUDFLARE_API_TOKEN: 'test-model-key',
          TURN_KEEPALIVE_INTERVAL_MS: '2000',
          TOOL_SANDBOX_MOCK: '1',
        },
      },
    }),
  ],
  // 单测 5s 默认超时在慢环境(容器/共享 CI,单个 workerd 请求可达 ~2s)下会误杀
  // 多请求用例;断言不变,只放宽等待上限
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 会话类文件并行时互相抢占共享的 node 侧 mock 模型服务(脚本队列与请求
    // 捕获是全局单例),文件级串行消除该竞态;单文件内用例本就顺序执行
    fileParallelism: false,
  },
});
