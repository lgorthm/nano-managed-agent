import { env, exports } from "cloudflare:workers";
import { API_KEY, authed } from "../helpers";

export { API_KEY, authed };

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

/** Environment 响应的断言形状 */
export interface EnvironmentJson {
  id: string;
  type: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  config: {
    type: string;
    packages: { type: string } & Record<string, string[]>;
    networking: Record<string, unknown>;
  };
  scope: string;
  state: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 错误信封的断言形状 */
export interface ErrorEnvelope {
  type: string;
  error: { type: string; message: string; details?: { issues?: Array<{ path: string; message: string }> } };
  request_id: string;
}

/** 分页响应的断言形状 */
export interface PageJson<T> {
  data: T[];
  next_page: string | null;
}

/** POST /v1/environments,默认带认证 */
export function postEnvironment(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch("http://example.com/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** GET /v1/environments/{environmentId},默认带认证 */
export function getEnvironment(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(id)}`, {
    headers: authed(headers),
  });
}

/** GET /v1/environments?{query},默认带认证 */
export function listEnvironments(query = "", headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/environments${query}`, { headers: authed(headers) });
}

/** POST /v1/environments/{environmentId},默认带认证;body 为 null 时发送空请求体 */
export function updateEnvironment(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { ...authed(headers) },
  };
  if (body === null) {
    init.headers = { ...init.headers };
  } else {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(id)}`, init);
}

/** POST /v1/environments/{environmentId}/archive,默认带认证 */
export function archiveEnvironmentViaApi(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    headers: authed(headers),
  });
}

/** DELETE /v1/environments/{environmentId},默认带认证 */
export function deleteEnvironmentViaApi(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/environments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authed(headers),
  });
}

/** 测试夹具:绕过接口直改库,把 Environment 置为已归档 */
export async function archiveEnvironmentInDb(environmentId: string): Promise<void> {
  await env.DB.prepare("UPDATE environments SET state = 'archived', archived_at = ? WHERE id = ?")
    .bind(Date.now(), environmentId)
    .run();
}

/** 创建一个最小 Environment 并返回其响应(测试数据工厂) */
export async function createDefaultEnvironment(body?: Record<string, unknown>): Promise<EnvironmentJson> {
  const res = await postEnvironment(body ?? { name: "test-env" });
  if (res.status !== 201) {
    throw new Error(`fixture create failed: ${res.status} ${await res.text()}`);
  }
  return jsonBody<EnvironmentJson>(res);
}
