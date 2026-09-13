/**
 * 事件日志 → 模型调用上下文的组装纯函数(runtime.md §4.2 第 1 步)。
 * 输入是终事件数组(按 seq 升序,含未消费的输入事件),输出 GLM chat
 * completions 的 messages;同一函数服务每轮迭代与崩溃恢复后的重组。
 *
 * M2 扩展点:agent.tool_use / agent.tool_result 的映射与 tools 参数;
 * 三期扩展点:compaction(thread_context_compacted 截断历史)。两者都
 * 通过在下方 switch 加分支实现,签名不动。
 */
import type { ContentBlock, PersistedEventJson } from "./events";

/** chat completions 的内容部分(GLM / OpenAI 兼容形态;纯文本时折叠为 string) */
export type ChatTextPart = { type: "text"; text: string };
export type ChatImagePart = { type: "image_url"; image_url: { url: string } };
export type ChatPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatPart[];
}

/** 组装输入:agent_config 快照的 system prompt + 事件日志(终事件,升序) */
export interface TurnContextInput {
  system: string | null;
  events: PersistedEventJson[];
}

/** document 块引用 file 时,正文物化属 M2 的 R2 供给,先以占位符进入上下文 */
function documentPlaceholder(fileId: string): string {
  return `[document file: ${fileId}]`;
}

/** 事件载荷的 content 块 → chat 内容:全文本折叠为 string,含图片则用 parts 数组 */
function contentToChatContent(blocks: ContentBlock[]): string | ChatPart[] {
  const parts: ChatPart[] = [];
  let textRun = "";
  for (const block of blocks) {
    if (block.type === "text") {
      textRun += (textRun === "" ? "" : "\n") + block.text;
    } else if (block.type === "image") {
      if (textRun !== "") {
        parts.push({ type: "text", text: textRun });
        textRun = "";
      }
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    } else if (block.source.type === "text") {
      const titled = block.title !== null && block.title !== undefined ? `${block.title}\n` : "";
      textRun += (textRun === "" ? "" : "\n") + titled + block.source.data;
    } else {
      textRun += (textRun === "" ? "" : "\n") + documentPlaceholder(block.source.file_id);
    }
  }
  if (parts.length === 0) return textRun;
  if (textRun !== "") parts.push({ type: "text", text: textRun });
  return parts;
}

/** 事件 content 块的断言形状(PersistedEventJson 是开放信封,这里收窄) */
function eventContent(event: PersistedEventJson): ContentBlock[] | null {
  const content = event.content;
  if (!Array.isArray(content)) return null;
  return content as ContentBlock[];
}

/**
 * 终事件 → messages:
 * - user.message → user 轮;agent.message → assistant 轮(逐事件一条,保留粒度)
 * - agent.thinking 不回放——GLM 推理模型自行管理推理,输入侧回传会被拒绝
 * - 其余类型(status / usage / error / interrupt / 确认 / 平台消息)不进模型上下文
 */
export function assembleChatMessages(input: TurnContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (input.system !== null && input.system !== "") {
    messages.push({ role: "system", content: input.system });
  }
  for (const event of input.events) {
    if (event.type !== "user.message" && event.type !== "agent.message") continue;
    const blocks = eventContent(event);
    if (blocks === null || blocks.length === 0) continue;
    const content = contentToChatContent(blocks);
    if (content === "") continue;
    messages.push({ role: event.type === "user.message" ? "user" : "assistant", content });
  }
  return messages;
}
