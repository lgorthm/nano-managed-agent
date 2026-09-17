/**
 * mock 模型上游的 workerd 侧控制端(pool-workers 测试代码运行在 workerd 里,
 * 经 fetch 调 node 侧 server 的 admin 端点;见 server.ts 头注释)。
 */
import type { CapturedModelRequest, MockModelScript } from './types';

const ADMIN = 'http://127.0.0.1:18234';

export type { CapturedModelRequest, MockModelScript } from './types';

/** 编排一次模型响应;match 标记见 types.ts(自定义脚本务必携带) */
export async function enqueueModelScript(script: MockModelScript): Promise<void> {
  const res = await fetch(`${ADMIN}/__admin/script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(script),
  });
  if (!res.ok) throw new Error(`mock model enqueue failed: ${res.status}`);
}

/** 清空脚本队列与请求捕获(beforeEach 调用,隔离用例间状态) */
export async function resetModelMock(): Promise<void> {
  const res = await fetch(`${ADMIN}/__admin/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`mock model reset failed: ${res.status}`);
}

/** 已捕获的模型请求(上下文装配与凭据断言用) */
export async function modelRequests(): Promise<CapturedModelRequest[]> {
  const res = await fetch(`${ADMIN}/__admin/captured`);
  if (!res.ok) throw new Error(`mock model captured failed: ${res.status}`);
  return (await res.json()) as CapturedModelRequest[];
}

/** 轮询直到捕获请求数达标(恢复类用例等首次请求到达) */
export async function waitForModelRequests(
  count: number,
  timeoutMs = 5000,
): Promise<CapturedModelRequest[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const requests = await modelRequests();
    if (requests.length >= count) return requests;
    if (Date.now() > deadline) {
      throw new Error(`waitForModelRequests timed out; captured: ${requests.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
