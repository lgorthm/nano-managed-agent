/**
 * 全生命周期 E2E(runtime.md §10 M4 验收):wrangler dev + mock 模型上游 +
 * mock 沙箱,驱动「创建(initial_events)→ 对话 → 工具挂起 → 审批 → 续跑 →
 * interrupt → 归档 → 删除」全程,逐步断言事件序列。
 *
 * 用法:node scripts/e2e-session-lifecycle.mjs(需要本机可运行 wrangler dev;
 * 沙箱走 mock,不需要 Docker;模型走本地 mock,不需要真实凭据)
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
} from './e2e-helpers.mjs';

const PORT = 18901;
const MODEL_PORT = 18301;

const persistTo = makeTempDir();
const mock = await startMockModel(MODEL_PORT);
const server = bootApi({ port: PORT, modelPort: MODEL_PORT, persistTo });
const client = api(PORT);

try {
  await applyMigrations(persistTo);
  await waitReady(PORT);
  console.log('✓ api ready (wrangler dev, persistTo 隔离)');

  // 1. 前置资源:bash 为 always_ask,其余 always_allow
  const agent = (
    await client.createAgent({
      name: 'e2e-agent',
      model: 'glm-5.3',
      system: 'You are the e2e agent.',
      tools: [
        {
          type: 'agent_toolset_20260601',
          configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
        },
      ],
    })
  ).body;
  const env = (
    await client.createEnvironment({
      name: 'e2e-env',
      config: {
        type: 'cloud',
        packages: { pip: [] },
        networking: { type: 'unrestricted' },
      },
    })
  ).body;
  assert(agent?.id && env?.id, 'agent/environment created');

  // 2. 创建带 initial_events:异步完成一轮对话
  const session = (
    await client.createSession({
      agent: agent.id,
      environment_id: env.id,
      title: 'e2e lifecycle',
      initial_events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'bootstrap hello' }],
        },
      ],
    })
  ).body;
  assert(session?.id, 'session created');
  const first = await pollEvents(client, session.id, (events) =>
    events.some((event) => event.type === 'session.status_idle'),
  );
  assert(
    JSON.stringify(first.map((e) => e.type)) ===
      JSON.stringify([
        'user.message',
        'session.status_running',
        'agent.thinking',
        'agent.message',
        'session.usage',
        'session.status_idle',
      ]),
    'initial_events 完成首个 turn',
  );
  assert(first.at(-1).stop_reason.type === 'end_turn', '首个 turn end_turn');
  console.log('✓ initial_events → 首轮对话完成');

  // 3. always_ask 工具挂起
  mock.enqueue({
    match: 'lifecycle-tool',
    chunks: [{ content: 'need shell' }],
    tool_calls: [
      {
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo lifecycle-ok' }),
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
  await client.sendEvents(session.id, [
    {
      type: 'user.message',
      content: [{ type: 'text', text: 'please lifecycle-tool now' }],
    },
  ]);
  const suspended = await pollEvents(
    client,
    session.id,
    (events) => events.filter((e) => e.type === 'session.status_idle').length >= 2,
  );
  const idle = suspended.filter((e) => e.type === 'session.status_idle').at(-1);
  assert(idle.stop_reason.type === 'requires_action', '工具调用挂起 requires_action');
  assert(idle.stop_reason.event_ids.length === 1, 'event_ids 指向待审批 tool_use');
  const toolUse = suspended.find((e) => e.type === 'agent.tool_use');
  assert(toolUse && toolUse.id === idle.stop_reason.event_ids[0], 'tool_use_id 即事件 id');
  console.log('✓ always_ask 工具挂起(requires_action)');

  // 4. 审批 allow → 执行(mock 沙箱)→ 续跑到 end_turn
  await client.sendEvents(session.id, [
    {
      type: 'user.tool_confirmation',
      tool_use_id: toolUse.id,
      result: 'allow',
    },
  ]);
  const resumed = await pollEvents(
    client,
    session.id,
    (events) => events.filter((e) => e.type === 'session.status_idle').length >= 3,
  );
  const toolResult = resumed.filter((e) => e.type === 'agent.tool_result').at(-1);
  assert(toolResult.tool_use_id === toolUse.id, '审批后 tool_result 配对');
  assert(JSON.stringify(toolResult.content).includes('mock:bash'), 'mock 沙箱执行结果');
  assert(
    resumed.filter((e) => e.type === 'session.status_idle').at(-1).stop_reason.type === 'end_turn',
    '续跑 end_turn',
  );
  console.log('✓ 审批 allow → 执行 → 续跑完成');

  // 5. interrupt:慢流中掐断
  mock.enqueue({
    match: 'lifecycle-slow',
    chunks: [{ content: 'wor', delayMs: 9000 }, { content: 'd' }],
  });
  await client.sendEvents(session.id, [
    {
      type: 'user.message',
      content: [{ type: 'text', text: 'please lifecycle-slow now' }],
    },
  ]);
  console.log(`[t] message sent at ${Date.now()}`);
  await sleep(500);
  const interruptRes = await client.sendEvents(session.id, [{ type: 'user.interrupt' }]);
  console.log(`[t] interrupt sent at ${Date.now()} status=${interruptRes.status}`);
  const interrupted = await pollEvents(
    client,
    session.id,
    (events) => events.filter((e) => e.type === 'session.status_idle').length >= 4,
  );
  const lastIdle = interrupted.filter((e) => e.type === 'session.status_idle').at(-1);
  assert(
    lastIdle.stop_reason.type === 'interrupted',
    `interrupted 收尾(实际 ${JSON.stringify(lastIdle.stop_reason)};事件 ${JSON.stringify(interrupted.map((e) => e.type))})`,
  );
  assert(
    !interrupted
      .slice(interrupted.findIndex((e) => e.type === 'user.interrupt'))
      .some((e) => e.type === 'agent.message'),
    '无半截终事件',
  );
  console.log('✓ 流中途 interrupt(无半截产出)');

  // 6. 归档(idle 可归档)与删除
  assert((await client.archiveSession(session.id)).status === 200, '归档成功');
  assert((await client.deleteSession(session.id)).status === 200, '删除成功');
  assert((await client.getSession(session.id)).status === 404, '删除后 GET 404');
  console.log('✓ 归档 → 删除');

  console.log('\nPASS: 全生命周期 E2E 通过');
  process.exitCode = 0;
} catch (err) {
  console.error('\nFAIL:', err.message);
  console.error(server.logs().split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  await server.stop();
  await mock.close();
  cleanupDir(persistTo);
}
