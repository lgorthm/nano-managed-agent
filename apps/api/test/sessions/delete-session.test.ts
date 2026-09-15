import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import {
  applyMigrations,
  archiveSessionViaApi,
  createDefaultFile,
  createDefaultSession,
  deleteSessionViaApi,
  getSession,
  jsonBody,
  postSession,
  setSessionStatusInDb,
  type SessionJson,
} from "./helpers";
import { createDefaultAgent, createDefaultEnvironment } from "./helpers";

beforeAll(applyMigrations);

describe("DELETE /v1/sessions/{sessionId}", () => {
  it("删除成功返回 {id, type:'session_deleted'},之后 GET 404、重复删除 404", async () => {
    const created = await createDefaultSession();
    const res = await deleteSessionViaApi(created.id);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ id: created.id, type: "session_deleted" });

    expect((await getSession(created.id)).status).toBe(404);
    expect((await deleteSessionViaApi(created.id)).status).toBe(404);
  });

  // 反直觉点②:已归档会话可以删除(归档不是"终态不可动")
  it("已归档会话允许删除", async () => {
    const created = await createDefaultSession();
    expect((await archiveSessionViaApi(created.id)).status).toBe(200);
    const res = await deleteSessionViaApi(created.id);
    expect(res.status).toBe(200);
    expect((await getSession(created.id)).status).toBe(404);
  });

  it("running 会话删除返回 409", async () => {
    const created = await createDefaultSession();
    await setSessionStatusInDb(created.id, "running");
    expect((await deleteSessionViaApi(created.id)).status).toBe(409);
  });

  it("删除级联清理挂载记录,File 本体不受影响", async () => {
    const agent = await createDefaultAgent();
    const environment = await createDefaultEnvironment();
    const file = await createDefaultFile();
    const created = await jsonBody<SessionJson>(
      await postSession({
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: file.id }],
      }),
    );

    expect((await deleteSessionViaApi(created.id)).status).toBe(200);

    const mounts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM session_resources WHERE session_id = ?",
    )
      .bind(created.id)
      .first<{ n: number }>();
    expect(mounts?.n).toBe(0);

    // File 仍可读取(独立资源,不随会话删除)
    const { getFile } = await import("../files/helpers");
    expect((await getFile(file.id)).status).toBe(200);
  });

  it("删除级联清理产出编目:映射行、File 行与 R2 对象一起清", async () => {
    const { harvestSessionOutputs } = await import("../../src/runtime/tools/catalog");
    const { objectExistsInR2 } = await import("../files/helpers");
    const created = await createDefaultSession();
    await harvestSessionOutputs(env as unknown as Env, created.id, [
      { path: "out/report.md", bytes: new TextEncoder().encode("# bye\n") },
    ]);
    const output = await env.DB.prepare(
      "SELECT file_id FROM session_outputs WHERE session_id = ?",
    )
      .bind(created.id)
      .first<{ file_id: string }>();
    expect(output).not.toBeNull();
    const fileId = output!.file_id;

    expect((await deleteSessionViaApi(created.id)).status).toBe(200);

    const outputs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM session_outputs WHERE session_id = ?",
    )
      .bind(created.id)
      .first<{ n: number }>();
    expect(outputs?.n).toBe(0);
    const fileRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?")
      .bind(fileId)
      .first<{ n: number }>();
    expect(fileRows?.n).toBe(0);
    expect(await objectExistsInR2(fileId)).toBe(false);
  });

  it("产出被其他会话挂载时,源会话删除留下悬空挂载,资源列表与目标会话不受影响", async () => {
    // 悬空挂载是已知取舍:挂载是软引用,物化读取对缺失 file 有 null-continue 防御
    const { harvestSessionOutputs } = await import("../../src/runtime/tools/catalog");
    const { getFile } = await import("../files/helpers");
    const { postResource, listResources } = await import("./helpers");
    const source = await createDefaultSession();
    await harvestSessionOutputs(env as unknown as Env, source.id, [
      { path: "shared.txt", bytes: new TextEncoder().encode("shared") },
    ]);
    const output = await env.DB.prepare(
      "SELECT file_id FROM session_outputs WHERE session_id = ?",
    )
      .bind(source.id)
      .first<{ file_id: string }>();
    const fileId = output!.file_id;

    const consumer = await createDefaultSession();
    expect((await postResource(consumer.id, { type: "file", file_id: fileId })).status).toBe(201);

    expect((await deleteSessionViaApi(source.id)).status).toBe(200);

    // 挂载行仍在(软引用),file 本体随源会话删除 → 点查 404
    expect((await listResources(consumer.id)).status).toBe(200);
    expect((await getFile(fileId)).status).toBe(404);
  });

  it("不存在的 id 返回 404", async () => {
    expect((await deleteSessionViaApi("sess_00000000-0000-7000-8000-000000000000")).status).toBe(404);
  });
});
