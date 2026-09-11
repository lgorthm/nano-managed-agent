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

/** Skill 响应的断言形状 */
export interface SkillJson {
  id: string;
  type: string;
  display_title: string | null;
  source: string;
  latest_version: string | null;
  created_at: string;
  updated_at: string;
}

/** SkillVersion 响应的断言形状 */
export interface SkillVersionJson {
  id: string;
  type: string;
  skill_id: string;
  version: string;
  name: string;
  description: string;
  directory: string;
  created_at: string;
}

/** 分页响应的断言形状 */
export interface PageJson<T> {
  data: T[];
  next_page: string | null;
}

/** 错误信封的断言形状 */
export interface ErrorEnvelope {
  type: string;
  error: { type: string; message: string; details?: Record<string, unknown> };
  request_id: string;
}

/** 最小合法 SKILL.md */
export function skillMd(name = "demo-skill", description = "A demo skill for tests."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDemo body.\n`;
}

/**
 * 构造 multipart form:files 的键是 Skill 内相对路径,text 是文本字段(display_title 等)。
 * File.name 用路径末段填充,服务端只认字段名。
 */
export function skillForm(
  files: Record<string, string | Uint8Array>,
  text: Record<string, string> = {},
): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(text)) {
    form.append(name, value);
  }
  for (const [path, content] of Object.entries(files)) {
    form.append(
      path,
      new File([content], path.split("/").pop() ?? path, { type: "application/octet-stream" }),
    );
  }
  return form;
}

/** multipart POST;不手动设置 content-type,由 fetch 生成带 boundary 的头 */
function postForm(url: string, form: FormData, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(url, { method: "POST", headers: authed(headers), body: form });
}

/** POST /v1/skills,默认带认证 */
export function postSkill(form: FormData, headers: Record<string, string> = {}): Promise<Response> {
  return postForm("http://example.com/v1/skills", form, headers);
}

/** POST /v1/skills/{skillId}/versions,默认带认证 */
export function postSkillVersion(
  skillId: string,
  form: FormData,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postForm(`http://example.com/v1/skills/${encodeURIComponent(skillId)}/versions`, form, headers);
}

/** GET 类请求,默认带认证 */
function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(url, { headers: authed(headers) });
}

/** DELETE 类请求,默认带认证 */
function del(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(url, { method: "DELETE", headers: authed(headers) });
}

export function getSkill(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return get(`http://example.com/v1/skills/${encodeURIComponent(id)}`, headers);
}

export function listSkills(query = "", headers: Record<string, string> = {}): Promise<Response> {
  return get(`http://example.com/v1/skills${query}`, headers);
}

export function listSkillVersions(id: string, query = "", headers: Record<string, string> = {}): Promise<Response> {
  return get(`http://example.com/v1/skills/${encodeURIComponent(id)}/versions${query}`, headers);
}

export function getSkillVersion(id: string, version: string, headers: Record<string, string> = {}): Promise<Response> {
  return get(`http://example.com/v1/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, headers);
}

export function downloadSkillZip(id: string, version: string, headers: Record<string, string> = {}): Promise<Response> {
  return get(
    `http://example.com/v1/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/content`,
    headers,
  );
}

export function deleteSkill(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return del(`http://example.com/v1/skills/${encodeURIComponent(id)}`, headers);
}

export function deleteSkillVersion(id: string, version: string, headers: Record<string, string> = {}): Promise<Response> {
  return del(`http://example.com/v1/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, headers);
}

/** 创建一个最小 Skill(仅 SKILL.md)并返回其响应(测试数据工厂) */
export async function createDefaultSkill(
  files?: Record<string, string | Uint8Array>,
  text?: Record<string, string>,
): Promise<SkillJson> {
  const res = await postSkill(skillForm(files ?? { "SKILL.md": skillMd() }, text));
  if (res.status !== 201) {
    throw new Error(`fixture create failed: ${res.status} ${await res.text()}`);
  }
  return jsonBody<SkillJson>(res);
}

/** POST /v1/agents(带 JSON 体),供引用联动用例构造 Agent */
export function postAgent(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch("http://example.com/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** POST /v1/agents/{agentId}(带 JSON 体),供解除引用用例更新 Agent */
export function updateAgent(id: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/agents/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(headers) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 测试夹具:直查库,读取 skills 行的分配器与指针 */
export async function readSkillRowInDb(skillId: string): Promise<{
  latest_version_seq: number | null;
  next_version: number;
} | null> {
  return env.DB.prepare("SELECT latest_version_seq, next_version FROM skills WHERE id = ?")
    .bind(skillId)
    .first<{ latest_version_seq: number | null; next_version: number }>();
}

/** 测试夹具:直查库,统计三张表的行数(删除后的残留断言) */
export async function countSkillRowsInDb(skillId: string): Promise<{
  skills: number;
  versions: number;
  files: number;
}> {
  const count = async (table: string, column = "skill_id"): Promise<number> => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .bind(skillId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  };
  return {
    skills: await count("skills", "id"),
    versions: await count("skill_versions"),
    files: await count("skill_files"),
  };
}
