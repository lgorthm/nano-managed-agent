import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveEnvironmentInDb,
  createDefaultAgent,
  createDefaultEnvironment,
  createDefaultFile,
  jsonBody,
  listEvents,
  postSession,
  type AgentJson,
  type ErrorEnvelope,
  type PageJson,
  type SessionJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("POST /v1/sessions 成功路径", () => {
  it("最小请求(agent 字符串 + environment_id)创建成功,固定回显字段齐全", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      title: "Data analysis session",
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<SessionJson>(res);
    expect(body.id).toMatch(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.type).toBe("session");
    expect(body.agent).toEqual({
      id: agent.id,
      type: "agent",
      name: "test-agent",
      model: { id: "glm-5.3", effort: "max", speed: "standard" },
      system: null,
      description: null,
      tools: [],
      skills: [],
      mcp_servers: [],
      multiagent: null,
      version: 1,
    });
    expect(body.environment_id).toBe(environment.id);
    expect(body.status).toBe("idle");
    expect(body.title).toBe("Data analysis session");
    expect(body.metadata).toEqual({});
    expect(body.resources).toEqual([]);
    expect(body.vault_ids).toEqual([]);
    expect(body.outcome_evaluations).toEqual([]);
    expect(body.stats).toEqual({ active_seconds: 0, duration_seconds: 0 });
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    expect(body.budget).toBeNull();
    expect(body.archived_at).toBeNull();
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.updated_at).toBe(body.created_at);
  });

  it("兼容字段 agent_id 与 agent 等价", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({ agent_id: agent.id, environment_id: environment.id });
    expect(res.status).toBe(201);
    expect((await jsonBody<SessionJson>(res)).agent.id).toBe(agent.id);
  });

  it("{type:'agent', version:3} 钉住历史版本,Agent 后续升级不影响会话", async () => {
    const agent = await createDefaultAgent();
    // 两次覆盖式更新把 current_version 推到 3,各版本 system 不同
    const { updateAgent } = await import("../agents/helpers");
    await updateAgent(agent.id, { system: "v2 system" });
    await updateAgent(agent.id, { system: "v3 system" });

    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: { type: "agent", id: agent.id, version: 2 },
      environment_id: environment.id,
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<SessionJson>(res);
    expect(body.agent.version).toBe(2);
    expect(body.agent.system).toBe("v2 system");

    // 省略 version 钉当前版本(3)
    const current = await jsonBody<SessionJson>(
      await postSession({ agent: { type: "agent", id: agent.id }, environment_id: environment.id }),
    );
    expect(current.agent.version).toBe(3);
    expect(current.agent.system).toBe("v3 system");
  });

  it("agent_with_overrides 覆盖 system 与 tools,Agent 本体不变", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: {
        type: "agent_with_overrides",
        id: agent.id,
        system: "You are a code reviewer. Only review, never modify files.",
        tools: [{ type: "agent_toolset_20260601", default_config: { enabled: false }, configs: [{ name: "read", enabled: true }] }],
      },
      environment_id: environment.id,
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<SessionJson>(res);
    expect(body.agent.system).toBe("You are a code reviewer. Only review, never modify files.");
    expect(body.agent.tools).toEqual([
      {
        type: "agent_toolset_20260601",
        default_config: { enabled: false, permission_policy: { type: "always_allow" } },
        configs: [{ name: "read", enabled: true, permission_policy: { type: "always_allow" } }],
      },
    ]);
    expect(body.agent.version).toBe(agent.version);

    // Agent 本体不受覆盖影响
    const { getAgent } = await import("../agents/helpers");
    const fresh = await jsonBody<AgentJson>(await getAgent(agent.id));
    expect(fresh.system).toBeNull();
    expect(fresh.tools).toEqual([]);
  });

  it("挂载 resources:省略 mount_path 得默认路径,相对路径回显归一化绝对路径", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const [fileA, fileB] = await Promise.all([createDefaultFile(), createDefaultFile()]);
    const res = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: "file", file_id: fileA.id },
        { type: "file", file_id: fileB.id, mount_path: "datasets/q2-sales.csv" },
      ],
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<SessionJson>(res);
    expect(body.resources).toHaveLength(2);
    // 同一 batch 写入的资源共享时间戳,回显顺序不保证与提交顺序一致,按 mount_path 断言
    const byPath = new Map(body.resources.map((resource) => [resource.mount_path, resource]));
    expect(byPath.get(`/mnt/session/uploads/${fileA.id}`)?.file_id).toBe(fileA.id);
    expect(byPath.get("/mnt/session/uploads/datasets/q2-sales.csv")?.file_id).toBe(fileB.id);
    for (const resource of body.resources) {
      expect(resource.id).toMatch(/^sres_/);
    }
  });
});

describe("POST /v1/sessions 引用校验(404/400 分界)", () => {
  it("agent 不存在返回 404", async () => {
    const environment = await createDefaultEnvironment();
    const res = await postSession({ agent: "agent_00000000-0000-7000-8000-000000000000", environment_id: environment.id });
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("not_found_error");
  });

  it("钉不存在的版本返回 400,message 提示当前最新版本", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: { type: "agent", id: agent.id, version: 99 },
      environment_id: environment.id,
    });
    expect(res.status).toBe(400);
    const error = (await jsonBody<ErrorEnvelope>(res)).error;
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("99");
    expect(error.message).toContain("latest version is 1");
  });

  it("environment 不存在返回 404,已归档返回 400", async () => {
    const agent = await createDefaultAgent();
    const missing = await postSession({
      agent: agent.id,
      environment_id: "env_00000000-0000-7000-8000-000000000000",
    });
    expect(missing.status).toBe(404);

    const archivedEnvironment = await createDefaultEnvironment();
    await archiveEnvironmentInDb(archivedEnvironment.id);
    const archived = await postSession({ agent: agent.id, environment_id: archivedEnvironment.id });
    expect(archived.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(archived)).error.type).toBe("invalid_request_error");
  });

  it("resources[].file_id 不存在返回 400", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [{ type: "file", file_id: "file_00000000-0000-7000-8000-000000000000" }],
    });
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("invalid_request_error");
  });

  it("挂载路径逃逸与重叠返回 400", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const [fileA, fileB] = await Promise.all([createDefaultFile(), createDefaultFile()]);

    const escape = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [{ type: "file", file_id: fileA.id, mount_path: "../escape" }],
    });
    expect(escape.status).toBe(400);

    const overlap = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: "file", file_id: fileA.id, mount_path: "data" },
        { type: "file", file_id: fileB.id, mount_path: "data/inner.csv" },
      ],
    });
    expect(overlap.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(overlap)).error.message).toContain("overlaps");
  });
});

describe("POST /v1/sessions 一期裁剪与请求校验", () => {
  it("agent 与 agent_id 均缺失返回 400", async () => {
    const environment = await createDefaultEnvironment();
    const res = await postSession({ environment_id: environment.id });
    expect(res.status).toBe(400);
  });

  it("initial_events 随事件运行时放开:非空创建成功且初始消息可见", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    expect(res.status).toBe(201);
    const events = await listEvents((await jsonBody<SessionJson>(res)).id);
    const types = (await jsonBody<PageJson<{ type: string }>>(events)).data.map((event) => event.type);
    expect(types).toContain("user.message");
  });

  it("initial_events 携带 document 块返回 400(GLM:创建不允许该块)", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      initial_events: [
        {
          type: "user.message",
          content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "doc" } }],
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("vault_ids 非空返回 400", async () => {
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: (await createDefaultAgent()).id,
      environment_id: environment.id,
      vault_ids: ["vault_1"],
    });
    expect(res.status).toBe(400);
  });

  it("type: memory_store 资源返回 400;不带凭证返回 401", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const memoryStore = await postSession({
      agent: agent.id,
      environment_id: environment.id,
      resources: [{ type: "memory_store", memory_store_id: "ms_1" }],
    });
    expect(memoryStore.status).toBe(400);

    const unauthorized = await postSession({ agent: agent.id, environment_id: environment.id }, { Authorization: "Bearer wrong" });
    expect(unauthorized.status).toBe(401);
  });

  it("覆盖后的最终配置违反 mcp 映射返回 400", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const res = await postSession({
      agent: {
        type: "agent_with_overrides",
        id: agent.id,
        tools: [{ type: "mcp_toolset", mcp_server_name: "knowledge-base" }],
      },
      environment_id: environment.id,
    });
    expect(res.status).toBe(400);
    const error = (await jsonBody<ErrorEnvelope>(res)).error;
    expect(error.message).toContain("Resolved session agent configuration is invalid");
  });
});
