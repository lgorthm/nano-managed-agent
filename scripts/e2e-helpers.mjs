/**
 * E2E 脚本共享设施(runtime.md §9 的脚本级验证,不进 vitest)。
 * 负责:mock 模型上游(node:http)、wrangler dev 的受控启停(persistTo 隔离、
 * --var 注入测试配置)、API 轮询断言辅助。仅用 node 内置模块。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

export const API_KEY = "dev-key-change-me";

// ---------- mock 模型上游 ----------

/**
 * 按请求体 match 匹配的 mock 上游:队首匹配脚本被消费,否则回落缺省脚本
 * (thinking + message + usage)。与 apps/api/test/mock-model 同构的精简版。
 */
export function startMockModel(port) {
  const queue = [];
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push(raw);
      const index = queue.findIndex((script) => script.match === undefined || raw.includes(script.match));
      const script = index === -1 ? defaultScript() : queue.splice(index, 1)[0];
      console.log(`[mock] ${new Date().toISOString()} matched=${script.match ?? "default"} delay=${script.chunks?.[0]?.delayMs ?? 0}ms`);
      if ((script.status ?? 200) >= 400) {
        res.writeHead(script.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock upstream error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (script.hang) return;
      for (const chunk of script.chunks ?? []) {
        if (chunk.delayMs) await sleep(chunk.delayMs); // 异步等待:同步阻塞会拖住整个响应管线
        const delta = {};
        if (chunk.content !== undefined) delta.content = chunk.content;
        if (chunk.reasoning_content !== undefined) delta.reasoning_content = chunk.reasoning_content;
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      }
      if (script.tool_calls?.length) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: script.tool_calls.map((call, i) => ({
                    index: i,
                    id: `call_e2e_${i}`,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                },
              },
            ],
          })}\n\n`,
        );
      }
      const usage = script.usage ?? { prompt_tokens: 11, completion_tokens: 3 };
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, prompt_tokens_details: { cached_tokens: 0 } },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        enqueue: (script) => queue.push(script),
        requests: captured,
        // hang 用例会留着未完成响应:closeAllConnections 强制断开,close 才能返回
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });
}

function defaultScript() {
  return { chunks: [{ reasoning_content: "thinking…" }, { content: "e2e reply" }] };
}

// ---------- wrangler dev 受控启停 ----------

export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "nano-e2e-"));
}

/**
 * 启动 api 的 wrangler dev:独立 persistTo、注入模型上游/沙箱 mock/保活间隔。
 * detached 进程组便于 SIGKILL 整组(连 workerd 子进程一起)。
 */
export function bootApi({ port, modelPort, persistTo }) {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(port),
      // inspector 端口随机化:与并行的 pnpm dev(默认 9229)互不抢占
      "--inspector-port",
      "0",
      "--persist-to",
      persistTo,
      "--var",
      `GLM_API_BASE:http://127.0.0.1:${modelPort}`,
      "--var",
      "GLM_API_KEY:e2e-key",
      "--var",
      "TOOL_SANDBOX_MOCK:1",
      "--var",
      "TURN_KEEPALIVE_INTERVAL_MS:2000",
    ],
    {
      cwd: new URL("../apps/api/", import.meta.url),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return {
    child,
    logs: () => logs,
    stop: () =>
      new Promise((resolve) => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        child.on("exit", () => resolve());
      }),
  };
}

/** 迁移到指定 persistTo(每次全新目录都要跑) */
export async function applyMigrations(persistTo) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo],
    { cwd: new URL("../apps/api/", import.meta.url), stdio: "pipe", input: "y\n" },
  );
}

export async function waitReady(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // 尚未就绪
    }
    await sleep(500);
  }
  throw new Error(`api on :${port} not ready within ${timeoutMs}ms`);
}

// ---------- API 驱动 ----------

export function api(port) {
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    call,
    createAgent: (input) => call("/v1/agents", { method: "POST", body: JSON.stringify(input) }),
    createEnvironment: (input) => call("/v1/environments", { method: "POST", body: JSON.stringify(input) }),
    createSession: (input) => call("/v1/sessions", { method: "POST", body: JSON.stringify(input) }),
    getSession: (id) => call(`/v1/sessions/${id}`),
    archiveSession: (id) => call(`/v1/sessions/${id}/archive`, { method: "POST" }),
    deleteSession: (id) => call(`/v1/sessions/${id}`, { method: "DELETE" }),
    sendEvents: (id, events) =>
      call(`/v1/sessions/${id}/events`, { method: "POST", body: JSON.stringify({ events }) }),
    listEvents: (id, query = "") => call(`/v1/sessions/${id}/events${query}`),
  };
}

/** 轮询事件直到谓词命中;返回全部事件 */
export async function pollEvents(client, sessionId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await client.listEvents(sessionId);
    if (body && predicate(body.data)) return body.data;
    if (Date.now() > deadline) throw new Error(`pollEvents timed out; events: ${JSON.stringify(body)}`);
    await sleep(250);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}
