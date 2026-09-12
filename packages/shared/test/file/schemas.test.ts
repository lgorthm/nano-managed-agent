import { describe, expect, it } from "vitest";
import {
  MAX_FILENAME_LENGTH,
  MAX_MIME_TYPE_LENGTH,
  SCOPE_ID_PATTERN,
  fileObjectKey,
  normalizeMimeType,
  validateFilename,
} from "../../src/file/schemas";

describe("validateFilename", () => {
  it("空文件名非法", () => {
    expect(validateFilename("")).not.toBeNull();
  });

  it("恰好 256 字符合法,257 非法", () => {
    expect(validateFilename("a".repeat(MAX_FILENAME_LENGTH))).toBeNull();
    expect(validateFilename("a".repeat(MAX_FILENAME_LENGTH + 1))).not.toBeNull();
  });

  it("按字符数而非字节数计数(CJK)", () => {
    expect(validateFilename("文".repeat(MAX_FILENAME_LENGTH))).toBeNull();
    expect(validateFilename("文".repeat(MAX_FILENAME_LENGTH + 1))).not.toBeNull();
  });

  it("保留原始文件名中的路径与特殊字符(原样存储由调用方保证)", () => {
    expect(validateFilename("报告 v2 (最终版).pdf")).toBeNull();
    expect(validateFilename("a/b/c.txt")).toBeNull();
  });
});

describe("normalizeMimeType", () => {
  it("去掉参数并转小写", () => {
    expect(normalizeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeMimeType("Application/PDF")).toBe("application/pdf");
    expect(normalizeMimeType("  text/markdown ; charset=utf-8  ")).toBe("text/markdown");
  });

  it("缺失、为空或不成 type/subtype 形态时为 application/octet-stream", () => {
    expect(normalizeMimeType(null)).toBe("application/octet-stream");
    expect(normalizeMimeType(undefined)).toBe("application/octet-stream");
    expect(normalizeMimeType("")).toBe("application/octet-stream");
    expect(normalizeMimeType("garbage")).toBe("application/octet-stream");
    expect(normalizeMimeType("text/plain extra")).toBe("application/octet-stream");
    expect(normalizeMimeType("/json")).toBe("application/octet-stream");
  });

  it("essence 超过上限视为不可解析", () => {
    const long = `${"a".repeat(MAX_MIME_TYPE_LENGTH)}x/application`;
    expect(long.length).toBeGreaterThan(MAX_MIME_TYPE_LENGTH);
    expect(normalizeMimeType(long)).toBe("application/octet-stream");
  });
});

describe("fileObjectKey / SCOPE_ID_PATTERN", () => {
  it("对象键恒为 files/{fileId}", () => {
    expect(fileObjectKey("file_01911111-3333-7444-8555-666666666666")).toBe(
      "files/file_01911111-3333-7444-8555-666666666666",
    );
  });

  it("scope_id 只认 sess_ 前缀", () => {
    expect(SCOPE_ID_PATTERN.test("sess_whatever")).toBe(true);
    expect(SCOPE_ID_PATTERN.test("agent_01911111")).toBe(false);
    expect(SCOPE_ID_PATTERN.test("sessx")).toBe(false);
    expect(SCOPE_ID_PATTERN.test("")).toBe(false);
  });
});
