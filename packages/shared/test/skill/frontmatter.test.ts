import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter } from "../../src";

const encode = (text: string) => new TextEncoder().encode(text);

const VALID = "---\nname: pdf-processing\ndescription: 从 PDF 中提取文本与表格数据。\n---\n\n# PDF 处理\n";

describe("parseSkillFrontmatter 成功路径", () => {
  it("解析合法块,提取 name 与 description", () => {
    const result = parseSkillFrontmatter(encode(VALID));
    expect(result).toEqual({
      ok: true,
      data: { name: "pdf-processing", description: "从 PDF 中提取文本与表格数据。" },
    });
  });

  it("多余键被忽略,不影响解析", () => {
    const result = parseSkillFrontmatter(
      encode("---\nname: demo\ndescription: d\nallowed-tools: read, write\nversion: 2\n---\n"),
    );
    expect(result).toEqual({ ok: true, data: { name: "demo", description: "d" } });
  });

  it("CRLF 行尾同样接受", () => {
    const result = parseSkillFrontmatter(
      encode("---\r\nname: demo\r\ndescription: d\r\n---\r\n\r\nbody\r\n"),
    );
    expect(result).toEqual({ ok: true, data: { name: "demo", description: "d" } });
  });

  it("name 恰好 64 字符通过(63 个连字符接续首字符)", () => {
    const name = `a${"-".repeat(63)}`;
    const result = parseSkillFrontmatter(encode(`---\nname: ${name}\ndescription: d\n---\n`));
    expect(result).toMatchObject({ ok: true, data: { name } });
  });

  it("description 恰好 1024 字符通过", () => {
    const description = "d".repeat(1024);
    const result = parseSkillFrontmatter(encode(`---\nname: demo\ndescription: ${description}\n---\n`));
    expect(result).toMatchObject({ ok: true, data: { description } });
  });
});

describe("parseSkillFrontmatter 错误路径", () => {
  it("缺少起始 --- 报 missing_frontmatter", () => {
    const result = parseSkillFrontmatter(encode("name: demo\ndescription: d\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_frontmatter" } });
  });

  it("缺少闭合 --- 报 missing_frontmatter", () => {
    const result = parseSkillFrontmatter(encode("---\nname: demo\ndescription: d\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_frontmatter" } });
  });

  it("缺 name 报 missing_name", () => {
    const result = parseSkillFrontmatter(encode("---\ndescription: d\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_name" } });
  });

  it("缺 description 报 missing_description", () => {
    const result = parseSkillFrontmatter(encode("---\nname: demo\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_description" } });
  });

  it("name 含大写字母报 invalid_name", () => {
    const result = parseSkillFrontmatter(encode("---\nname: Demo\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_name" } });
  });

  it("name 含非法字符(下划线)报 invalid_name", () => {
    const result = parseSkillFrontmatter(encode("---\nname: demo_skill\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_name" } });
  });

  it("name 以连字符开头报 invalid_name", () => {
    const result = parseSkillFrontmatter(encode("---\nname: -demo\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_name" } });
  });

  it("name 超过 64 字符报 invalid_name", () => {
    const result = parseSkillFrontmatter(encode(`---\nname: ${"a".repeat(65)}\ndescription: d\n---\n`));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_name" } });
  });

  it("description 超过 1024 字符报 invalid_description", () => {
    const result = parseSkillFrontmatter(
      encode(`---\nname: demo\ndescription: ${"d".repeat(1025)}\n---\n`),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_description" } });
  });

  it("description 为空串按缺失处理", () => {
    const result = parseSkillFrontmatter(encode("---\nname: demo\ndescription:\n---\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_description" } });
  });
});
