import { describe, expect, it } from "vitest";
import {
  DELTA_EVENT_TYPES,
  EVENT_TYPES,
  InitialUserMessageEventSchema,
  PRODUCED_EVENT_TYPES,
  SendEventsRequestSchema,
} from "../../src";

describe("事件类型全集与二期子集", () => {
  it("全集 35 项与 GLM ManagedSessionEventTypes 一致", () => {
    expect(EVENT_TYPES).toHaveLength(35);
  });

  it("二期子集是全集的真子集", () => {
    expect(PRODUCED_EVENT_TYPES.every((type) => (EVENT_TYPES as readonly string[]).includes(type))).toBe(
      true,
    );
    expect(PRODUCED_EVENT_TYPES.length).toBeLessThan(EVENT_TYPES.length);
  });

  it("delta 类型仅 agent.message / agent.thinking", () => {
    expect(DELTA_EVENT_TYPES).toEqual(["agent.message", "agent.thinking"]);
  });
});

describe("SendEventsRequestSchema", () => {
  it("三种输入事件通过:文本、图片 base64、文档块", () => {
    const parsed = SendEventsRequestSchema.parse({
      events: [
        { type: "user.message", content: [{ type: "text", text: "hi" }] },
        {
          type: "user.message",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGk=" },
            },
          ],
        },
        {
          type: "user.message",
          content: [
            { type: "document", source: { type: "file", file_id: "file_1" }, title: "spec" },
          ],
        },
      ],
    });
    expect(parsed.events).toHaveLength(3);
  });

  it("user.interrupt 与 user.tool_confirmation 通过;deny 可带 deny_message", () => {
    expect(
      SendEventsRequestSchema.safeParse({ events: [{ type: "user.interrupt" }] }).success,
    ).toBe(true);
    expect(
      SendEventsRequestSchema.safeParse({
        events: [{ type: "user.tool_confirmation", tool_use_id: "sevt_tool_1", result: "deny", deny_message: "no" }],
      }).success,
    ).toBe(true);
  });

  it("allow 携带 deny_message 拒绝", () => {
    const result = SendEventsRequestSchema.safeParse({
      events: [{ type: "user.tool_confirmation", tool_use_id: "sevt_tool_1", result: "allow", deny_message: "no" }],
    });
    expect(result.success).toBe(false);
  });

  it("数组边界:空与 11 条拒绝;content 空数组与 21 块拒绝;未知键拒绝", () => {
    expect(SendEventsRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      SendEventsRequestSchema.safeParse({
        events: Array.from({ length: 11 }, () => ({ type: "user.interrupt" })),
      }).success,
    ).toBe(false);
    expect(
      SendEventsRequestSchema.safeParse({
        events: [{ type: "user.message", content: [] }],
      }).success,
    ).toBe(false);
    expect(
      SendEventsRequestSchema.safeParse({
        events: [
          {
            type: "user.message",
            content: Array.from({ length: 21 }, () => ({ type: "text", text: "x" })),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SendEventsRequestSchema.safeParse({ events: [{ type: "user.interrupt", extra: 1 }] }).success,
    ).toBe(false);
  });
});

describe("InitialUserMessageEventSchema(initial_events 的形状约束)", () => {
  it("文本与 base64 图片通过;document 块拒绝(GLM:创建/部署不允许)", () => {
    expect(
      InitialUserMessageEventSchema.safeParse({
        type: "user.message",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } },
        ],
      }).success,
    ).toBe(true);
    expect(
      InitialUserMessageEventSchema.safeParse({
        type: "user.message",
        content: [{ type: "document", source: { type: "file", file_id: "file_1" } }],
      }).success,
    ).toBe(false);
  });

  it("非 user.message 类型拒绝", () => {
    expect(InitialUserMessageEventSchema.safeParse({ type: "user.interrupt" }).success).toBe(false);
  });
});
