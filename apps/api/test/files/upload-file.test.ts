import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@nano/shared";
import {
  applyMigrations,
  authed,
  createDefaultFile,
  fileForm,
  jsonBody,
  postFile,
  type ErrorEnvelope,
  type FileJson,
} from "./helpers";

beforeAll(applyMigrations);

const ID_PATTERN = /^file_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("POST /v1/files 成功路径", () => {
  it("文档示例原样上传,响应逐字段对照;状态码是 200 而非 201", async () => {
    const res = await postFile(fileForm("%PDF-1.7 minimal", "report.pdf", "application/pdf"));
    expect(res.status).toBe(200);
    const body = await jsonBody<FileJson>(res);
    expect(body.id).toMatch(ID_PATTERN);
    expect(body.type).toBe("file");
    expect(body.size_bytes).toBe(16);
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.filename).toBe("report.pdf");
    expect(body.mime_type).toBe("application/pdf");
    expect(body.downloadable).toBe(true);
    // GLM 中可选的 scope 字段一期不输出
    expect(Object.keys(body).sort()).toEqual(
      ["created_at", "downloadable", "filename", "id", "mime_type", "size_bytes", "type"].sort(),
    );
  });

  it("二进制内容按字节数计数", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    const body = await createDefaultFile(bytes, "blob.bin", "application/octet-stream");
    expect(body.size_bytes).toBe(1024);
  });

  it("mime_type 归一化:去参数、转小写;缺失时为 application/octet-stream", async () => {
    const withParams = await createDefaultFile("x", "a.txt", "text/plain; charset=utf-8");
    expect(withParams.mime_type).toBe("text/plain");
    const upper = await createDefaultFile("x", "b.json", "Application/JSON");
    expect(upper.mime_type).toBe("application/json");
    const noType = await createDefaultFile("x", "c.dat");
    expect(noType.mime_type).toBe("application/octet-stream");
  });

  it("重复上传相同内容生成独立 File(不去重)", async () => {
    const first = await createDefaultFile("same");
    const second = await createDefaultFile("same");
    expect(second.id).not.toBe(first.id);
  });
});

describe("POST /v1/files 上传形态校验(400)", () => {
  it("请求不是 multipart/form-data 返回 400", async () => {
    const res = await exports.default.fetch("http://example.com/v1/files", {
      method: "POST",
      headers: { "content-type": "application/json", ...authed() },
      body: JSON.stringify({ filename: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("invalid_request_error");
  });

  it("缺 file 字段返回 400", async () => {
    const res = await postFile(new FormData());
    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.message).toContain("file");
  });

  it("file 字段传文本 part 返回 400", async () => {
    const form = new FormData();
    form.append("file", "plain text value");
    const res = await postFile(form);
    expect(res.status).toBe(400);
  });

  it("出现未知字段或第二个 file 字段返回 400", async () => {
    const withText = fileForm("x");
    withText.append("display_title", "extra");
    expect((await postFile(withText)).status).toBe(400);

    const twoFiles = fileForm("x");
    twoFiles.append("file", new File(["y"], "y.txt"));
    expect((await postFile(twoFiles)).status).toBe(400);
  });

  it("文件名缺失或超 256 字符返回 400", async () => {
    expect((await postFile(fileForm("x", ""))).status).toBe(400);
    expect((await postFile(fileForm("x", "a".repeat(257)))).status).toBe(400);
    expect((await postFile(fileForm("x", "a".repeat(256)))).status).toBe(200);
  });

  it("空文件(0 字节)返回 400", async () => {
    const res = await postFile(fileForm(new Uint8Array(0), "empty.txt", "text/plain"));
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/files 上限与认证", () => {
  it("单文件超过 50 MiB 返回 413 request_too_large", async () => {
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);
    const res = await postFile(fileForm(oversized, "big.bin", "application/octet-stream"));
    expect(res.status).toBe(413);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("request_too_large");
  });

  it("恰好 50 MiB 可以上传", async () => {
    const edge = new Uint8Array(MAX_FILE_BYTES);
    const res = await postFile(fileForm(edge, "edge.bin", "application/octet-stream"));
    expect(res.status).toBe(200);
    expect((await jsonBody<FileJson>(res)).size_bytes).toBe(MAX_FILE_BYTES);
  });

  it("缺少凭证返回 401", async () => {
    const res = await postFile(fileForm("x"), { Authorization: "" });
    expect(res.status).toBe(401);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("authentication_error");
  });
});
