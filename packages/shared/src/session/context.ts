/**
 * 事件日志 → 模型调用上下文的组装纯函数(runtime.md §4.2 第 1 步)。
 * 输入是终事件数组(按 seq 升序,含未消费的输入事件),输出 GLM chat
 * completions 的 messages;同一函数服务每轮迭代与崩溃恢复后的重组。
 *
 * 三期扩展点:compaction(thread_context_compacted 截断历史),经在下方
 * switch 加分支实现,签名不动。
 */
import type { ContentBlock, PersistedEventJson } from './events';

/** chat completions 的内容部分(GLM / OpenAI 兼容形态;纯文本时折叠为 string) */
export type ChatTextPart = { type: 'text'; text: string };
export type ChatImagePart = { type: 'image_url'; image_url: { url: string } };
export type ChatPart = ChatTextPart | ChatImagePart;

/** assistant 轮携带的工具调用(arguments 为 JSON 字符串,同上游 wire 形态) */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatPart[] | null;
  /** 仅 assistant 轮:本轮发起的工具调用 */
  tool_calls?: ChatToolCall[];
  /** 仅 tool 轮:回指的调用 id */
  tool_call_id?: string;
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
  let textRun = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      textRun += (textRun === '' ? '' : '\n') + block.text;
    } else if (block.type === 'image') {
      if (textRun !== '') {
        parts.push({ type: 'text', text: textRun });
        textRun = '';
      }
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    } else if (block.source.type === 'text') {
      const titled = block.title !== null && block.title !== undefined ? `${block.title}\n` : '';
      textRun += (textRun === '' ? '' : '\n') + titled + block.source.data;
    } else {
      textRun += (textRun === '' ? '' : '\n') + documentPlaceholder(block.source.file_id);
    }
  }
  if (parts.length === 0) return textRun;
  if (textRun !== '') parts.push({ type: 'text', text: textRun });
  return parts;
}

/** 事件 content 块的断言形状(PersistedEventJson 是开放信封,这里收窄) */
function eventContent(event: PersistedEventJson): ContentBlock[] | null {
  const content = event.content;
  if (!Array.isArray(content)) return null;
  return content as ContentBlock[];
}

/** tool_result 的载荷:content 块拼为纯文本回喂(工具结果不携带图片) */
function eventTextContent(event: PersistedEventJson): string | null {
  const content = event.content;
  if (typeof content === 'string') return content;
  const blocks = eventContent(event);
  if (blocks === null) return null;
  return blocks
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n');
}

/**
 * 终事件 → messages:
 * - user.message → user 轮;agent.message → assistant 轮(逐事件一条,保留粒度)
 * - agent.tool_use → 连续若干条合并为一条带 tool_calls 的 assistant 轮
 *   (id 用事件 id,即 §2.1 的「tool_use_id 就是事件 id」约定);
 *   agent.tool_result → tool 轮,tool_call_id 回指
 * - agent.thinking 不回放——GLM 推理模型自行管理推理,输入侧回传会被拒绝
 * - 其余类型(status / usage / error / interrupt / 确认 / 平台消息)不进模型上下文
 */
export function assembleChatMessages(input: TurnContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (input.system !== null && input.system !== '') {
    messages.push({ role: 'system', content: input.system });
  }
  let pendingToolCalls: ChatToolCall[] = [];
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };
  for (const event of input.events) {
    if (event.type === 'agent.tool_use') {
      const name = typeof event.name === 'string' ? event.name : 'unknown';
      pendingToolCalls.push({
        id: event.id,
        type: 'function',
        function: { name, arguments: JSON.stringify(event.input ?? {}) },
      });
      continue;
    }
    flushToolCalls();
    if (event.type === 'agent.tool_result') {
      const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
      const text = eventTextContent(event) ?? '';
      messages.push({ role: 'tool', tool_call_id: toolUseId, content: text });
      continue;
    }
    if (event.type !== 'user.message' && event.type !== 'agent.message') continue;
    const blocks = eventContent(event);
    if (blocks === null || blocks.length === 0) continue;
    const content = contentToChatContent(blocks);
    if (content === '') continue;
    messages.push({
      role: event.type === 'user.message' ? 'user' : 'assistant',
      content,
    });
  }
  flushToolCalls();
  return messages;
}
