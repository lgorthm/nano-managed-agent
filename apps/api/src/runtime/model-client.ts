/**
 * Cloudflare AI Gateway REST API 的 chat completions 流式客户端(runtime.md §1)。
 * 只负责传输与协议:退避 fetch + SSE 解析;delta 逐块回调给执行器,由执行器
 * 决定缓冲与落盘节奏。地址与凭据经 env 注入(集成测试的 AI_API_BASE 指向本地
 * mock 服务,真实凭据只用于冒烟)。
 *
 * 端点是 /accounts/{id}/ai/v1/chat/completions(OpenAI chat 格式)。注:同服务的
 * /ai/v1/responses 对 @cf 模型的支持按模型而定——实测 @cf/zai-org/* 不接受
 * Responses 输入形状(上游 400,工具形状报嵌套 function.name),故走本端点;
 * @cf 模型请求必带 cf-aig-gateway-id 头(官方要求,请求据此进网关日志)。
 *
 * 协议按 OpenAI 兼容形状实现:delta.reasoning_content → thinking,
 * delta.content → message,usage 随 stream_options.include_usage 在末块返回。
 */
import type { ChatMessage, ChatToolDefinition } from "@nano/shared";
import type { UsagePayload } from "@nano/shared";

/** 模型调用配置:baseUrl/apiKey/gatewayId 来自 env,model 是目录解析的 wire 名称 */
export interface ChatModelConfig {
  baseUrl: string;
  apiKey: string;
  /** 请求体 model 字段,如 @cf/zai-org/glm-5.3 */
  model: string;
  /** cf-aig-gateway-id 头的值(@cf 模型必带) */
  gatewayId: string;
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
  /** 模型发起的工具调用(arguments 为 JSON 字符串);空数组表示本轮无工具 */
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/** 连接类错误与可重试状态码(429/5xx)按退避重试;流已建立不重试(§0 的「十行包装」) */
const RETRY_DELAYS_MS = [200, 500];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url, init);
      if (RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        await response.body?.cancel().catch(() => undefined); // 丢弃错误体再重试
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return response;
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
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      /** OpenAI 兼容的流式工具调用:index 定位,arguments 分片累积 */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }> | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/** 按 index 累积分片到达的 tool_call(id/name 首块到位,arguments 逐片拼接) */
function accumulateToolCall(
  calls: Map<number, { id: string; name: string; arguments: string }>,
  fragment: NonNullable<NonNullable<NonNullable<StreamChunk["choices"]>[number]["delta"]>["tool_calls"]>[number],
): void {
  const index = fragment.index ?? 0;
  const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
  if (fragment.id !== undefined && fragment.id !== "") current.id = fragment.id;
  if (fragment.function?.name !== undefined && fragment.function.name !== "") {
    current.name = fragment.function.name;
  }
  if (fragment.function?.arguments !== undefined) current.arguments += fragment.function.arguments;
  calls.set(index, current);
}

function finishToolCalls(
  calls: Map<number, { id: string; name: string; arguments: string }>,
): Array<{ id: string; name: string; arguments: string }> {
  return [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
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
  config: ChatModelConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  tools?: ChatToolDefinition[],
): Promise<ModelCallResult> {
  const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      // @cf 模型请求必带(官方要求);同时让请求进入指定网关的日志看板
      "cf-aig-gateway-id": config.gatewayId,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // 空 tools 数组部分上游会报错;无可用工具时整个字段省略
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    }),
    signal: callbacks.signal,
  });
  if (!response.ok || response.body === null) {
    throw new ModelHttpError(response.status, await response.text().catch(() => ""));
  }

  let thinking = "";
  let message = "";
  let usage: UsagePayload = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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
        return { thinking, message, usage, toolCalls: finishToolCalls(toolCalls) };
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
      if (delta?.tool_calls !== undefined && delta.tool_calls !== null) {
        for (const fragment of delta.tool_calls) accumulateToolCall(toolCalls, fragment);
      }
    }
  }
  return { thinking, message, usage, toolCalls: finishToolCalls(toolCalls) };
}
