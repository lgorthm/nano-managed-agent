import { env, exports } from "cloudflare:workers";
import { fileObjectKey } from "@nano/shared";
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

/** File 响应的断言形状 */
export interface FileJson {
  id: string;
  type: string;
  size_bytes: number;
  created_at: string;
  filename: string;
  mime_type: string;
  downloadable: boolean;
}

/** 删除回执的断言形状 */
export interface FileDeletedJson {
  id: string;
  type: string;
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

/**
 * 构造单文件上传 form:一个 file 字段。
 * type 省略时 Form 构造器会置空字符串,等价于「part 未携带 Content-Type」。
 */
export function fileForm(
  content: string | Uint8Array,
  filename = "report.pdf",
  type?: string,
): FormData {
  const form = new FormData();
  const file = type === undefined ? new File([content], filename) : new File([content], filename, { type });
  form.append("file", file);
  return form;
}

/** multipart POST;不手动设置 content-type,由 fetch 生成带 boundary 的头 */
export function postFile(form: FormData, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch("http://example.com/v1/files", {
    method: "POST",
    headers: authed(headers),
    body: form,
  });
}

export function listFiles(query = "", headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/files${query}`, { headers: authed(headers) });
}

export function getFile(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/files/${encodeURIComponent(id)}`, {
    headers: authed(headers),
  });
}

export function downloadFile(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(
    `http://example.com/v1/files/${encodeURIComponent(id)}/content`,
    { headers: authed(headers) },
  );
}

export function deleteFile(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`http://example.com/v1/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authed(headers),
  });
}

/** 创建一个最小 File 并返回其响应(测试数据工厂) */
export async function createDefaultFile(
  content: string | Uint8Array = "hello nano\n",
  filename = "report.pdf",
  type?: string,
): Promise<FileJson> {
  const res = await postFile(fileForm(content, filename, type));
  if (res.status !== 200) {
    throw new Error(`fixture create failed: ${res.status} ${await res.text()}`);
  }
  return jsonBody<FileJson>(res);
}

/** 测试夹具:R2 对象是否仍存在(head 不读 body) */
export async function objectExistsInR2(fileId: string): Promise<boolean> {
  return (await env.FILES.head(fileObjectKey(fileId))) !== null;
}
