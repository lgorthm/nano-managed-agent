/**
 * SIGKILL 崩溃恢复 E2E(runtime.md §9,脚本级、不进 vitest):
 * wrangler dev(指定 persistTo)→ 触发挂起的模型流 → 对进程组 kill -9 →
 * 同一 persistTo 重启 → 断言三件事——孤儿 turn 被巡检恢复、终事件无重复
 * (预生成 id + append 去重)、system.message 已外发。
 *
 * 用法:node scripts/e2e-sigkill.mjs(不需要 Docker 与真实凭据,沙箱/模型均 mock)
 */
import {
  api,
  applyMigrations,
  assert,
  bootApi,
  cleanupDir,
  makeTempDir,
  pollEvents,
  sleep,
  startMockModel,
  waitReady,
} from "./e2e-helpers.mjs";

const PORT = 18902;
const MODEL_PORT = 18302;

const persistTo = makeTempDir();
const mock = await startMockModel(MODEL_PORT);
const client = api(PORT);

async function driveTurn(sessionId) {
  await client.sendEvents(sessionId, [
    { type: "user.message", content: [{ type: "text", text: "please sigkill-hang now" }] },
  ]);
  // 等首次模型请求到达并挂起(turn 行已在、模型流在途)
  for (let i = 0; i < 100 && mock.requests.length === 0; i++) await sleep(100);
  assert(mock.requests.length >= 1, "模型请求已到达");
}

try {
  await applyMigrations(persistTo);

  // 第一段:启动、建会话、触发挂起的 turn、SIGKILL
  let server = bootApi({ port: PORT, modelPort: MODEL_PORT, persistTo });
  await waitReady(PORT);
  const agent = (await client.createAgent({
    name: "sigkill-agent",
    model: "glm-5.3",
    tools: [{ type: "agent_toolset_20260601" }],
  })).body;
  const env = (await client.createEnvironment({
    name: "sigkill-env",
    config: { type: "cloud", packages: { pip: [] }, networking: { type: "unrestricted" } },
  })).body;
  const session = (await client.createSession({
    agent: agent.id,
    environment_id: env.id,
    title: "sigkill",
  })).body;
  mock.enqueue({ match: "sigkill-hang", hang: true, chunks: [] });
  await driveTurn(session.id);
  const before = (await client.listEvents(session.id)).body.data.map((e) => e.type);
  assert(before.includes("session.status_running"), "turn 在跑(status_running 已落)");
  console.log("✓ 第一段:turn 挂起在模型流上,事件:", before.join(" → "));

  await server.stop(); // 进程组 SIGKILL(连 workerd)
  console.log("✓ kill -9(进程组)");

  // 第二段:同一 persistTo 重启 → 构造唤醒触发恢复巡检
  server = bootApi({ port: PORT, modelPort: MODEL_PORT, persistTo });
  await waitReady(PORT);
  console.log("✓ 同 persistTo 重启完成");

  const events = await pollEvents(
    client,
    session.id,
    (list) => list.some((event) => event.type === "session.status_idle"),
    30000,
  );
  const types = events.map((event) => event.type);
  console.log("恢复后事件:", types.join(" → "));

  // 三件断言
  assert(types.includes("system.message"), "恢复通知 system.message 已外发");
  assert(types.indexOf("system.message") > types.indexOf("session.status_running"), "恢复发生在逐出之后");
  const counts = Object.groupBy(types, (t) => t);
  assert((counts["agent.thinking"] ?? []).length === 1, "终事件无重复:thinking ×1");
  assert((counts["agent.message"] ?? []).length === 1, "终事件无重复:message ×1");
  assert((counts["session.status_idle"] ?? []).length === 1, "终事件无重复:status_idle ×1");
  assert(events.at(-1).stop_reason.type === "end_turn", "恢复后续跑到 end_turn");
  // 重发策略:同一份上下文两次上行(逐出前 1 次 + 恢复重发 1 次)
  assert(mock.requests.length === 2, "策略 1 重发(同上下文第二次上行)");
  console.log("✓ 孤儿 turn 巡检恢复、终事件无重复、system.message 已外发");

  console.log("\nPASS: SIGKILL 崩溃恢复 E2E 通过");
  process.exitCode = 0;
} catch (err) {
  console.error("\nFAIL:", err.message);
  process.exitCode = 1;
} finally {
  await mock.close();
  cleanupDir(persistTo);
  if (typeof server !== "undefined") await server.stop();
}
