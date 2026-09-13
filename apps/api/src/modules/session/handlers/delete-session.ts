import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionDoStub } from "../../../runtime/session-do-stub";
import { sessionService } from "../service";

/**
 * DELETE /v1/sessions/{sessionId} — 硬删除会话及挂载记录(已归档会话可删)。
 * 删除联动(runtime.md §8):D1 行删除成功后清空 SESSION_DO 存储(广播
 * session.deleted、断开订阅);wipe 失败不影响删除结果——sessionId 是 UUIDv7,
 * 孤儿存储不会与新会话混名,容忍异步清理。
 */
export async function deleteSession(c: Context<AppEnv>) {
  const sessionId = c.req.param("sessionId") ?? "";
  const deleted = await sessionService.deleteSession(c.env, sessionId);
  c.executionCtx.waitUntil(
    sessionDoStub(c.env, sessionId)
      .wipe()
      .catch((err) => console.error("session storage wipe failed:", err)),
  );
  return c.json(deleted, 200);
}
