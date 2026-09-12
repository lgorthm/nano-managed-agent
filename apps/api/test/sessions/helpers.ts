import { env, exports } from "cloudflare:workers";
import { API_KEY, authed } from "../helpers";
export { API_KEY, authed } from "../helpers";
export { createDefaultAgent, type AgentJson } from "../agents/helpers";
export { createDefaultEnvironment, archiveEnvironmentInDb } from "../environments/helpers";
export { createDefaultFile } from "../files/helpers";

const migrationFiles = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let applied = false;

/** 对测试 D1 按文件名顺序应用全部迁移,幂等 */
export async function applyMigrations(): Promise<void> {
  if (applied) return;
  await env.DB.exec("CREATE TABLE IF NOT EXISTS _applied_migrations (name TEXT PRIMARY KEY)");
  const entries = Object.entries(migrationFiles).sort(([a], [b]) => a.localeCompare(b));
  for (const [path, sql] of entries) {
    const name = path.split("/").pop();
    if (!name) continue;
    const done = await env.DB.prepare("SELECT 1 FROM _applied_migrations WHERE name = ?").bind(name).first();
    if (done) continue;
    const statements = sql.split("--> statement-breakpoint").map((statement) => env.DB.prepare(statement));
    statements.push(env.DB.prepare("INSERT INTO _applied_migrations (name) VALUES (?)").bind(name));
    await env.DB.batch(statements);
  }
  applied = true;
}

/** res.json() 在 workers 类型下返回 unknown,这里统一做类型断言 */
export async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 挂载资源的断言形状 */
export interface FileResourceJson {
  id: string;
  type: string;
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}

/** Session 响应的断言形状 */
export interface SessionJson {
  id: string;
  type: string;
  agent: {
    id: string;
    type: string;
    name: string;
    model: { id: string; effort: string; speed: string };
    system: string | null;
    description: string | null;
    tools: unknown[];
    skills: unknown[];
    mcp_servers: unknown[];
    multiagent: null;
    version: number;
  };
  environment_id: string;
  status: string;
  title: string | null;
  metadata: Record<string, string>;
  resources: FileResourceJson[];
  vault_ids: string[];
  outcome_evaluations: unknown[];
  stats: { active_seconds: number; duration_seconds: number };
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  budget: null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** 错误信封的断言形状 */
export interface ErrorEnvelope {
  type: string;
  error: { type: string; message: string; details?: Record<string, unknown> };
  request_id: string;
}

/** 分页响应的断言形状 */
export interface PageJson<T> {
  data: T[];
  next_page: string | null;
}

const base = "http://example.com";

function sessionUrl(sessionId: string, suffix = ""): string {
  return `${base}/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

/** POST /v1/sessions,默认带认证 */
export function postSession(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** GET /v1/sessions?{query},默认带认证 */
export function listSessions(query = "", headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${base}/v1/sessions${query}`, { headers: authed(headers) });
}

/** GET /v1/sessions/{sessionId},默认带认证 */
export function getSession(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(sessionUrl(id), { headers: authed(headers) });
}

/** POST /v1/sessions/{sessionId},默认带认证 */
export function updateSession(id: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(sessionUrl(id), {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** POST /v1/sessions/{sessionId}/archive,默认带认证 */
export function archiveSessionViaApi(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(sessionUrl(id, "/archive"), { method: "POST", headers: authed(headers) });
}

/** DELETE /v1/sessions/{sessionId},默认带认证 */
export function deleteSessionViaApi(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(sessionUrl(id), { method: "DELETE", headers: authed(headers) });
}

/** POST /v1/sessions/{sessionId}/resources,默认带认证 */
export function postResource(sessionId: string, body: unknown): Promise<Response> {
  return exports.default.fetch(sessionUrl(sessionId, "/resources"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authed() },
    body: JSON.stringify(body),
  });
}

/** GET /v1/sessions/{sessionId}/resources?{query},默认带认证 */
export function listResources(sessionId: string, query = ""): Promise<Response> {
  return exports.default.fetch(sessionUrl(sessionId, `/resources${query}`), { headers: authed() });
}

/** GET /v1/sessions/{sessionId}/resources/{resourceId},默认带认证 */
export function getResource(sessionId: string, resourceId: string): Promise<Response> {
  return exports.default.fetch(sessionUrl(sessionId, `/resources/${encodeURIComponent(resourceId)}`), {
    headers: authed(),
  });
}

/** DELETE /v1/sessions/{sessionId}/resources/{resourceId},默认带认证 */
export function deleteResource(sessionId: string, resourceId: string): Promise<Response> {
  return exports.default.fetch(sessionUrl(sessionId, `/resources/${encodeURIComponent(resourceId)}`), {
    method: "DELETE",
    headers: authed(),
  });
}

/** 测试夹具:绕过接口直改库,把会话置为已归档 */
export async function archiveSessionInDb(sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?")
    .bind(Date.now(), sessionId)
    .run();
}

/** 测试夹具:绕过接口直改库,把会话置为 running(覆盖 running 门禁的"一期不可达"分支) */
export async function setSessionStatusInDb(sessionId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET status = ? WHERE id = ?").bind(status, sessionId).run();
}

/** 创建一个最小会话并返回其响应(测试数据工厂):先备好 agent 与 environment */
export async function createDefaultSession(body?: Record<string, unknown>): Promise<SessionJson> {
  const { createDefaultAgent, createDefaultEnvironment } = await import("./helpers");
  const [agent, environment] = await Promise.all([createDefaultAgent(), createDefaultEnvironment()]);
  const res = await postSession({
    agent: agent.id,
    environment_id: environment.id,
    title: "test session",
    ...body,
  });
  if (res.status !== 201) {
    throw new Error(`fixture create failed: ${res.status} ${await res.text()}`);
  }
  return jsonBody<SessionJson>(res);
}
