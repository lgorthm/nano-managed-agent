import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultSkill,
  getSkill,
  jsonBody,
  skillForm,
  skillMd,
  type ErrorEnvelope,
  type SkillJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("GET /v1/skills/{skillId}", () => {
  it("创建后获取,字段与创建响应一致", async () => {
    const created = await createDefaultSkill(
      { "SKILL.md": skillMd("readable-skill", "Readable.") },
      { display_title: "可读 Skill" },
    );
    const res = await getSkill(created.id);
    expect(res.status).toBe(200);
    expect(await jsonBody<SkillJson>(res)).toEqual(created);
  });

  it("不存在的 id 返回 404 且是完整错误信封", async () => {
    const res = await getSkill("skill_01911111-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found_error");
    expect(body.request_id).toMatch(/^req_/);
  });

  it("任意合法字符串 path 参数同样 404 而不是 500", async () => {
    const res = await getSkill("not-a-skill-id");
    expect(res.status).toBe(404);
  });

  it("不带凭证返回 401", async () => {
    const created = await createDefaultSkill();
    const res = await getSkill(created.id, { Authorization: "" });
    expect(res.status).toBe(401);
  });
});
