/**
 * mock 模型上游(node 侧,由 vitest.config.ts 顶部 import 启动)。
 * pool-workers 的测试代码运行在 workerd 里、起不了 node:http,因此 mock
 * 服务放 node 侧、以固定端口暴露,脚本编排与请求捕获经 admin 端点控制
 * (workerd 侧走 test/mock-model/client.ts)。
 *
 * /chat/completions:按 match 匹配消费脚本(见 types.ts),否则下发内置缺省
 * 脚本(thinking + message + usage),保证未编排的 turn 也确定性完成。发射的
 * 是 OpenAI chat 兼容的 SSE delta 流,与生产上游(Cloudflare AI Gateway
 * REST API 的 /ai/v1/chat/completions)同构。
 * admin:/__admin/script(enqueue)、/__admin/reset、/__admin/captured。
 */
import http from 'node:http';
import type { CapturedModelRequest, MockModelScript, MockModelToolCall } from './types';

const PORT = 18234;
const HOST = '127.0.0.1';

/** 缺省脚本:一次 thinking + 一次 message(两条 content 块)+ 非零 usage */
const DEFAULT_SCRIPT: MockModelScript = {
  chunks: [{ reasoning_content: 'Let me think.' }, { content: 'Hello' }, { content: '!' }],
  usage: { prompt_tokens: 12, completion_tokens: 34, cached_tokens: 0 },
};

const queue: MockModelScript[] = [];
const captured: CapturedModelRequest[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function pickScript(rawBody: string): MockModelScript {
  const index = queue.findIndex(
    (script) => script.match === undefined || rawBody.includes(script.match),
  );
  return index === -1 ? DEFAULT_SCRIPT : queue.splice(index, 1)[0]!;
}

function writeChunk(
  res: http.ServerResponse,
  delta: Record<string, string>,
  finishReason?: string,
): void {
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta,
          ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
        },
      ],
    })}\n\n`,
  );
}

/**
 * 工具调用按真实上游(OpenAI 兼容实现)的分片习惯下发:首块携带 index/id/name
 * 与首段 arguments,续块 name 为 JSON null、只追加 arguments 分片。单块完整
 * 下发曾让累积逻辑的 null 守卫漏洞逃过测试(生产表现为 Unknown tool "null")。
 */
function writeToolCallFragments(
  res: http.ServerResponse,
  index: number,
  call: MockModelToolCall,
): void {
  const pieces = splitArguments(call.arguments);
  const fragments: Array<Record<string, unknown>> = [
    {
      index,
      id: call.id ?? `call_mock_${index}`,
      type: 'function',
      function: { name: call.name, arguments: pieces[0] ?? '' },
    },
    ...pieces.slice(1).map((piece) => ({ index, function: { name: null, arguments: piece } })),
  ];
  for (const fragment of fragments) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [fragment] } }] })}\n\n`);
  }
}

/** arguments 一分为二(长度 ≥ 2 时),保证续块路径总被走到 */
function splitArguments(args: string): string[] {
  if (args.length < 2) return [args];
  const middle = Math.ceil(args.length / 2);
  return [args.slice(0, middle), args.slice(middle)];
}

async function handleCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body: CapturedModelRequest['body'];
  try {
    body = JSON.parse(rawBody) as CapturedModelRequest['body'];
  } catch {
    writeJson(res, 400, { error: { message: 'invalid json' } });
    return;
  }
  captured.push({
    url: req.url ?? '',
    authorization: req.headers.authorization ?? '',
    gatewayId: (req.headers['cf-aig-gateway-id'] as string | undefined) ?? '',
    body,
  });

  const script = pickScript(rawBody);
  if ((script.status ?? 200) >= 400) {
    writeJson(res, script.status!, {
      error: { message: 'mock upstream error' },
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (script.hang) return; // 挂起:连接保持,永不下发(流中断场景)
  for (const chunk of script.chunks) {
    if (chunk.delayMs !== undefined) await sleep(chunk.delayMs);
    const delta: Record<string, string> = {};
    if (chunk.content !== undefined) delta.content = chunk.content;
    if (chunk.reasoning_content !== undefined) delta.reasoning_content = chunk.reasoning_content;
    writeChunk(res, delta);
  }
  if ((script.tool_calls ?? []).length > 0) {
    for (const [index, call] of (script.tool_calls ?? []).entries()) {
      writeToolCallFragments(res, index, call);
    }
    writeChunk(res, {}, 'tool_calls');
  }
  if (script.usage !== undefined) {
    res.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: script.usage.prompt_tokens,
          completion_tokens: script.usage.completion_tokens,
          prompt_tokens_details: {
            cached_tokens: script.usage.cached_tokens ?? 0,
          },
        },
      })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

let started: Promise<void> | null = null;

/** 幂等启动;由 vitest.config.ts 顶层调用,存活至 vitest 进程结束 */
export function startMockModelServer(): Promise<void> {
  if (started !== null) return started;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/__admin/captured' && req.method === 'GET') {
      writeJson(res, 200, captured);
      return;
    }
    if (url.startsWith('/__admin/')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
        if (url === '/__admin/script' && req.method === 'POST') {
          queue.push(JSON.parse(body) as MockModelScript);
          writeJson(res, 200, { queued: queue.length });
        } else if (url === '/__admin/reset' && req.method === 'POST') {
          queue.length = 0;
          captured.length = 0;
          writeJson(res, 200, { reset: true });
        } else {
          writeJson(res, 404, { error: 'unknown admin endpoint' });
        }
      });
      return;
    }
    if (url === '/chat/completions' && req.method === 'POST') {
      void handleCompletions(req, res);
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  });
  // 挂起连接(流中断用例)不阻止 vitest 进程退出
  server.on('connection', (socket) => socket.unref());
  started = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve());
  });
  server.unref();
  return started;
}

export { PORT as MOCK_MODEL_PORT };
