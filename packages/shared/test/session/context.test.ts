import { describe, expect, it } from "vitest";
import { assembleChatMessages } from "../../src/session/context";
import type { EventType, PersistedEventJson } from "../../src/session/events";

/** 构造终事件(payload 字段按 type 展开在顶层,同 DO 落库形态) */
function event(type: EventType, fields: Record<string, unknown> = {}): PersistedEventJson {
  return {
    id: `sevt_${type}`,
    type,
    created_at: "2026-09-13T08:00:00.000Z",
    processed_at: "2026-09-13T08:00:00.000Z",
    ...fields,
  };
}

describe("assembleChatMessages system 拼装", () => {
  it("system 非空时作为首条消息", () => {
    const messages = assembleChatMessages({
      system: "You are a helpful coding agent.",
      events: [event("user.message", { content: [{ type: "text", text: "hi" }] })],
    });
    expect(messages[0]).toEqual({ role: "system", content: "You are a helpful coding agent." });
  });

  it("system 为 null 或空串时不产生 system 消息", () => {
    for (const system of [null, ""]) {
      const messages = assembleChatMessages({
        system,
        events: [event("user.message", { content: [{ type: "text", text: "hi" }] })],
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "hi" });
    }
  });
});

describe("assembleChatMessages 事件映射", () => {
  it("user.message → user 轮,agent.message → assistant 轮,顺序保留", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("user.message", { content: [{ type: "text", text: "第一问" }] }),
        event("agent.message", { content: [{ type: "text", text: "第一答" }] }),
        event("user.message", { content: [{ type: "text", text: "第二问" }] }),
      ],
    });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.map((message) => message.content)).toEqual(["第一问", "第一答", "第二问"]);
  });

  it("agent.thinking 不回放(输入侧回传推理会被 GLM 拒绝)", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("user.message", { content: [{ type: "text", text: "q" }] }),
        event("agent.thinking", { content: [{ type: "text", text: "推理过程" }] }),
        event("agent.message", { content: [{ type: "text", text: "a" }] }),
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "assistant", content: "a" });
  });

  it("非模型事件全部跳过(status / usage / idle / interrupt / 确认 / 平台消息 / 删除)", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("session.status_running"),
        event("user.message", { content: [{ type: "text", text: "q" }] }),
        event("session.usage", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 }),
        event("user.interrupt"),
        event("user.tool_confirmation", { tool_use_id: "sevt_x", result: "allow" }),
        event("system.message", { content: "recovered" }),
        event("session.status_idle", { stop_reason: { type: "end_turn" } }),
        event("session.deleted"),
      ],
    });
    expect(messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("未消费输入(processed_at null)同样进入上下文", () => {
    const pending = event("user.message", { content: [{ type: "text", text: "排队中" }] });
    pending.processed_at = null;
    const messages = assembleChatMessages({ system: null, events: [pending] });
    expect(messages).toEqual([{ role: "user", content: "排队中" }]);
  });

  it("content 非数组或缺content 的事件跳过,不抛错(信封是开放的,防御读取)", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [event("user.message"), event("user.message", { content: [] })],
    });
    expect(messages).toEqual([]);
  });
});

describe("assembleChatMessages content 块映射", () => {
  it("多个 text 块折叠为单个字符串(换行连接)", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("user.message", {
          content: [
            { type: "text", text: "第一段" },
            { type: "text", text: "第二段" },
          ],
        }),
      ],
    });
    expect(messages[0]).toEqual({ role: "user", content: "第一段\n第二段" });
  });

  it("image 块转 data URL,与 text 混排时用 parts 数组", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("user.message", {
          content: [
            { type: "text", text: "看这张图" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGk=" },
            },
          ],
        }),
      ],
    });
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      ],
    });
  });

  it("document 的 text/plain 内联为文本(带标题),file_id 以占位符进入(M2 物化)", () => {
    const messages = assembleChatMessages({
      system: null,
      events: [
        event("user.message", {
          content: [
            { type: "document", source: { type: "text", media_type: "text/plain", data: "正文" }, title: "说明" },
            { type: "document", source: { type: "file", file_id: "file_abc" } },
          ],
        }),
      ],
    });
    expect(messages[0]).toEqual({
      role: "user",
      content: "说明\n正文\n[document file: file_abc]",
    });
  });
});
