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

/** POST /v1/agents,默认带认证 */
export function postAgent(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch("http://example.com/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 读取错误信封的公共断言结构 */
export interface ErrorEnvelope {
  type: string;
  error: { type: string; message: string; details?: { issues?: Array<{ path: string; message: string }> } };
  request_id: string;
}
