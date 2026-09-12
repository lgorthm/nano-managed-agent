import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultFile,
  downloadFile,
  jsonBody,
  type ErrorEnvelope,
} from "./helpers";

beforeAll(applyMigrations);

const TEXT_BODY = "%PDF-1.7 minimal binary-ish payload\n";

describe("GET /v1/files/{fileId}/content", () => {
  it("响应头由元数据决定,字节与上传一致", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const uploaded = await createDefaultFile(bytes, "report.pdf", "application/pdf");
    const res = await downloadFile(uploaded.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
    // R2 单次 put 的 ETag 为内容 MD5 的带引号 hex
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("content-type 恒为存储的 mime_type,不随实际内容嗅探变化", async () => {
    const uploaded = await createDefaultFile(TEXT_BODY, "data.txt", "text/plain; charset=utf-8");
    const res = await downloadFile(uploaded.id);
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("非 ASCII 文件名按 RFC 5987 追加 filename*", async () => {
    const uploaded = await createDefaultFile("你好", "季度报告.pdf", "application/pdf");
    const res = await downloadFile(uploaded.id);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("季度报告.pdf")}`);
  });

  it("不存在的 id 返回 404", async () => {
    const res = await downloadFile("file_01911111-3333-7444-8555-666666666666");
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("not_found_error");
  });

  it("缺少凭证返回 401", async () => {
    const res = await downloadFile("whatever", { Authorization: "" });
    expect(res.status).toBe(401);
  });
});
