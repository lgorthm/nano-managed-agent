/**
 * GLM chat completions 流式客户端(runtime.md §1 的「GLM 模型 API」)。
 * 只负责传输与协议:退避 fetch + SSE 解析;delta 逐块回调给执行器,由执行器
 * 决定缓冲与落盘节奏。上游地址与凭据经 env 注入(集成测试指向本地 mock
 * 服务,真实凭据只用于 curl 冒烟)。
 *
 * 协议按 GLM v4(OpenAI 兼容)形状实现:delta.reasoning_content → thinking,
 * delta.content → message,usage 随 include_usage 在末块返回。
 */
import type { ChatMessage } from "@nano/shared";
import type { UsagePayload } from "@nano/shared";

/** 模型调用配置:baseUrl 与 apiKey 来自 env,model 来自会话的 agent_config 快照 */
export interface GlmModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type DeltaKind = "thinking" | "message";

/** 中断(执行器在 delta 回调里发现 interrupt 后 abort) */
export class ModelAbortedError extends Error {
  constructor() {
    super("Model call aborted.");
  }
}

/** 上游非 2xx:执行器转 turnFailed → session.error(错误分诊细化属 M4) */
export class ModelHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Model API returned ${status}.`);
  }
}

export interface StreamCallbacks {
  onDelta(kind: DeltaKind, text: string): void;
  /** 掐断在途请求(user.interrupt) */
  signal?: AbortSignal;
}

export interface ModelCallResult {
  thinking: string;
  message: string;
  usage: UsagePayload;
}

/** 连接类错误(fetch 抛出、未收到响应头)按退避重试;流已建立不重试(§0 的「十行包装」) */
const RETRY_DELAYS_MS = [200, 500];

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw new ModelAbortedError();
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastError;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

function parseUsage(chunk: StreamChunk): UsagePayload | null {
  const usage = chunk.usage;
  if (usage === undefined || usage === null) return null;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export async function streamChatCompletion(
  config: GlmModelConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
): Promise<ModelCallResult> {
  const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: callbacks.signal,
  });
  if (!response.ok || response.body === null) {
    throw new ModelHttpError(response.status, await response.text().catch(() => ""));
  }

  let thinking = "";
  let message = "";
  let usage: UsagePayload = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  const reader = response.body.getReader();
  // 显式吸收 abort 时的流取消:workerd 在 abort 掐断流式响应时会在运行时
  // 内部留一个被拒绝的取消 promise,不挂 catch 会以 unhandled rejection 漏出
  callbacks.signal?.addEventListener("abort", () => {
    void reader.cancel().catch(() => undefined);
    void response.body?.cancel().catch(() => undefined);
  });
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") {
        await reader.cancel().catch(() => undefined);
        return { thinking, message, usage };
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue; // 上游注释行 / 空帧,跳过
      }
      const captured = parseUsage(chunk);
      if (captured !== null) usage = captured;
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
        thinking += delta.reasoning_content;
        callbacks.onDelta("thinking", delta.reasoning_content);
      }
      if (typeof delta?.content === "string" && delta.content !== "") {
        message += delta.content;
        callbacks.onDelta("message", delta.content);
      }
    }
  }
  return { thinking, message, usage };
}
