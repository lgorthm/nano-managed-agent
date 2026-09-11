import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authed,
  createDefaultSkill,
  jsonBody,
  postSkill,
  skillForm,
  skillMd,
  type ErrorEnvelope,
  type SkillJson,
} from "./helpers";

beforeAll(applyMigrations);

const ID_PATTERN = /^skill_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("POST /v1/skills 成功路径", () => {
  it("文档示例原样创建,响应逐字段对照", async () => {
    const res = await postSkill(
      skillForm(
        {
          "pdf-tools/SKILL.md": skillMd("pdf-processing", "从 PDF 中提取文本与表格数据。"),
          "pdf-tools/scripts/extract_text.py": "import sys\n",
        },
        { display_title: "PDF 处理" },
      ),
    );
    expect(res.status).toBe(201);
    const body = await jsonBody<SkillJson>(res);
    expect(body.id).toMatch(ID_PATTERN);
    expect(body.type).toBe("skill");
    expect(body.display_title).toBe("PDF 处理");
    expect(body.source).toBe("custom");
    expect(body.latest_version).toBe("1");
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.updated_at).toBe(body.created_at);
  });

  it("无前缀上传时 directory 回显 frontmatter name(经 get-version 验证)", async () => {
    const skill = await createDefaultSkill({ "SKILL.md": skillMd("bare-skill") });
    expect(skill.id).toMatch(ID_PATTERN);
  });

  it("重复上传相同内容也生成独立 Skill", async () => {
    const first = await createDefaultSkill();
    const second = await createDefaultSkill();
    expect(second.id).not.toBe(first.id);
  });
});

describe("POST /v1/skills 上传形态校验(400)", () => {
  it("缺 SKILL.md 返回 400", async () => {
    const res = await postSkill(skillForm({ "scripts/x.py": "x" }));
    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("SKILL.md");
  });

  it("frontmatter 缺 name 返回 400", async () => {
    const res = await postSkill(skillForm({ "SKILL.md": "---\ndescription: d\n---\n" }));
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("name");
  });

  it("frontmatter name 含大写返回 400", async () => {
    const res = await postSkill(skillForm({ "SKILL.md": skillMd("Demo") }));
    expect(res.status).toBe(400);
  });

  it("路径含 .. 段返回 400", async () => {
    const res = await postSkill(
      skillForm({ "SKILL.md": skillMd(), "a/../evil.txt": "x" }),
    );
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("..");
  });

  it("多个顶层目录无法定根返回 400", async () => {
    const res = await postSkill(skillForm({ "a/SKILL.md": skillMd(), "b/x.py": "x" }));
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("top-level");
  });

  it("未知文本字段返回 400", async () => {
    const res = await postSkill(skillForm({ "SKILL.md": skillMd() }, { title: "x" }));
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("Unknown multipart text field");
  });

  it("display_title 超 256 字符返回 400", async () => {
    const res = await postSkill(skillForm({ "SKILL.md": skillMd() }, { display_title: "x".repeat(257) }));
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("display_title");
  });

  it("content-type 不是 multipart 返回 400", async () => {
    const res = await exports.default.fetch("http://example.com/v1/skills", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("multipart/form-data");
  });
});

describe("POST /v1/skills 尺寸与数量上限", () => {
  it("单文件超 1 MiB 返回 413 request_too_large", async () => {
    const res = await postSkill(
      skillForm({ "SKILL.md": new Uint8Array(1024 * 1024 + 1) }),
    );
    expect(res.status).toBe(413);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("request_too_large");
  });

  it("文件数超 256 返回 400", async () => {
    const files: Record<string, string> = { "SKILL.md": skillMd() };
    for (let i = 0; i < 256; i++) files[`f${i}.txt`] = "x";
    const res = await postSkill(skillForm(files));
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain("257");
  });
});

describe("POST /v1/skills 认证", () => {
  it("不带凭证返回 401", async () => {
    const res = await postSkill(skillForm({ "SKILL.md": skillMd() }), {
      Authorization: "",
    });
    expect(res.status).toBe(401);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("authentication_error");
  });
});
