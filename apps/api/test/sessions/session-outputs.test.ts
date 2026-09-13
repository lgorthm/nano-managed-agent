import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@nano/shared";
import type { Env } from "../../src/env";
import {
  harvestSessionOutputs,
  type HarvestResult,
} from "../../src/runtime/tools/catalog";
import {
  applyMigrations,
  archiveSessionViaApi,
  createDefaultSession,
  jsonBody,
  type PageJson,
  type SessionJson,
} from "./helpers";
import {
  deleteFile,
  downloadFile,
  getFile,
  listFiles,
  objectExistsInR2,
  type FileJson,
} from "../files/helpers";

beforeAll(applyMigrations);

const encoder = new TextEncoder();

/** 直调收割编目(绕过沙箱;SandboxToolRunner 只负责把沙箱读成这份快照) */
function harvest(
  sessionId: string,
  files: Array<{ path: string; content: string | Uint8Array }>,
): Promise<HarvestResult> {
  return harvestSessionOutputs(env as unknown as Env, sessionId, files.map((file) => ({
    path: file.path,
    bytes: typeof file.content === "string" ? encoder.encode(file.content) : file.content,
  })));
}

async function outputRows(sessionId: string): Promise<Array<{ file_id: string; path: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT file_id, path FROM session_outputs WHERE session_id = ? ORDER BY path",
  )
    .bind(sessionId)
    .all<{ file_id: string; path: string }>();
  return results ?? [];
}

async function fileRow(fileId: string): Promise<{ filename: string; mime_type: string } | null> {
  return env.DB.prepare("SELECT filename, mime_type FROM files WHERE id = ?")
    .bind(fileId)
    .first<{ filename: string; mime_type: string }>();
}

describe("harvestSessionOutputs(收割编目)", () => {
  it("首收:新文件编目为 File 资源,filename 是相对路径,mime 按扩展名推断,R2 对象就位", async () => {
    const session = await createDefaultSession();
    const result = await harvest(session.id, [
      { path: "report.md", content: "# hello\n" },
      { path: "charts/a.png", content: new Uint8Array([1, 2, 3]) },
    ]);
    expect(result).toEqual({ created: 2, replaced: 0, removed: 0, skippedUnchanged: 0 });

    const rows = await outputRows(session.id);
    expect(rows.map((row) => row.path)).toEqual(["charts/a.png", "report.md"]);
    for (const row of rows) {
      expect(await objectExistsInR2(row.file_id)).toBe(true);
    }
    const report = await fileRow(rows[1]!.file_id);
    expect(report).toEqual({ filename: "report.md", mime_type: "text/markdown" });
    const png = await fileRow(rows[0]!.file_id);
    expect(png).toEqual({ filename: "charts/a.png", mime_type: "image/png" });
  });

  it("幂等:同内容重复收割零写入,file id 稳定", async () => {
    const session = await createDefaultSession();
    await harvest(session.id, [{ path: "a.txt", content: "v1" }]);
    const first = (await outputRows(session.id))[0]!;

    const result = await harvest(session.id, [{ path: "a.txt", content: "v1" }]);
    expect(result.skippedUnchanged).toBe(1);
    expect(result.created).toBe(0);

    const second = (await outputRows(session.id))[0]!;
    expect(second.file_id).toBe(first.file_id);
  });

  it("换代:内容变化换新 file id,旧行旧对象清理,新对象内容即新内容", async () => {
    const session = await createDefaultSession();
    await harvest(session.id, [{ path: "a.txt", content: "v1" }]);
    const oldFileId = (await outputRows(session.id))[0]!.file_id;

    const result = await harvest(session.id, [{ path: "a.txt", content: "v2" }]);
    expect(result).toEqual({ created: 0, replaced: 1, removed: 0, skippedUnchanged: 0 });

    const newFileId = (await outputRows(session.id))[0]!.file_id;
    expect(newFileId).not.toBe(oldFileId);
    expect(await objectExistsInR2(oldFileId)).toBe(false);
    expect(await objectExistsInR2(newFileId)).toBe(true);
    expect(await fileRow(oldFileId)).toBeNull();

    const downloaded = await downloadFile(newFileId);
    expect(await downloaded.text()).toBe("v2");
  });

  it("差集:沙箱里消失的产出连行带对象清理", async () => {
    const session = await createDefaultSession();
    await harvest(session.id, [
      { path: "keep.txt", content: "k" },
      { path: "gone.txt", content: "g" },
    ]);
    const goneFileId = (await outputRows(session.id)).find((row) => row.path === "gone.txt")!.file_id;

    const result = await harvest(session.id, [{ path: "keep.txt", content: "k" }]);
    expect(result.removed).toBe(1);

    const rows = await outputRows(session.id);
    expect(rows.map((row) => row.path)).toEqual(["keep.txt"]);
    expect(await objectExistsInR2(goneFileId)).toBe(false);
    expect(await fileRow(goneFileId)).toBeNull();
  });

  it("超限产出跳过编目,其余文件正常收敛", async () => {
    const session = await createDefaultSession();
    const result = await harvest(session.id, [
      { path: "small.txt", content: "ok" },
      { path: "huge.bin", content: new Uint8Array(MAX_FILE_BYTES + 1) },
    ]);
    expect(result.created).toBe(1);
    expect((await outputRows(session.id)).map((row) => row.path)).toEqual(["small.txt"]);
  });

  it("非法相对路径跳过编目", async () => {
    const session = await createDefaultSession();
    const result = await harvest(session.id, [
      { path: "../escape.txt", content: "x" },
      { path: "/abs.txt", content: "x" },
    ]);
    expect(result.created).toBe(0);
    expect(await outputRows(session.id)).toEqual([]);
  });
});

describe("会话产出的 File wire 语义", () => {
  async function sessionWithOutput(content = "payload"): Promise<{ session: SessionJson; fileId: string }> {
    const session = await createDefaultSession();
    await harvest(session.id, [{ path: "out/report.txt", content }]);
    const row = (await outputRows(session.id))[0]!;
    return { session, fileId: row.file_id };
  }

  it("scope_id 过滤返回挂载 ∪ 产出,产出回显 scope", async () => {
    const { session, fileId } = await sessionWithOutput();
    // 同时挂载一个用户上传的文件,验证挂载 ∪ 产出
    const { createDefaultFile, postResource } = await import("./helpers");
    const uploaded = await createDefaultFile();
    expect((await postResource(session.id, { type: "file", file_id: uploaded.id })).status).toBe(201);

    const page = await jsonBody<PageJson<FileJson & { scope?: { type: string; id: string } }>>(
      await listFiles(`?scope_id=${session.id}`),
    );
    const ids = page.data.map((file) => file.id).sort();
    expect(ids).toEqual([fileId, uploaded.id].sort());
    for (const file of page.data) {
      expect(file.scope).toEqual({ type: "session", id: session.id });
    }
  });

  it("全局列表:产出恒回显 scope,上传文件不回显", async () => {
    const { session, fileId } = await sessionWithOutput();
    const { createDefaultFile } = await import("./helpers");
    const uploaded = await createDefaultFile();

    const page = await jsonBody<PageJson<FileJson & { scope?: { type: string; id: string } }>>(
      await listFiles(),
    );
    const byId = new Map(page.data.map((file) => [file.id, file]));
    expect(byId.get(fileId)?.scope).toEqual({ type: "session", id: session.id });
    expect(byId.get(uploaded.id)?.scope).toBeUndefined();
  });

  it("get-file 与下载端点:产出文件可点查、可下载且内容一致", async () => {
    const { session, fileId } = await sessionWithOutput("binary \u00e9\n");

    const meta = await jsonBody<FileJson & { scope?: { type: string; id: string } }>(await getFile(fileId));
    expect(meta.filename).toBe("out/report.txt");
    expect(meta.scope).toEqual({ type: "session", id: session.id });

    const res = await downloadFile(fileId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("binary \u00e9\n");
  });

  it("未归档会话的产出拒删(400),归档后可删且映射行级联清理", async () => {
    const { session, fileId } = await sessionWithOutput();
    expect((await deleteFile(fileId)).status).toBe(400);

    expect((await archiveSessionViaApi(session.id)).status).toBe(200);
    expect((await deleteFile(fileId)).status).toBe(200);
    expect(await objectExistsInR2(fileId)).toBe(false);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_outputs WHERE session_id = ?")
      .bind(session.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
