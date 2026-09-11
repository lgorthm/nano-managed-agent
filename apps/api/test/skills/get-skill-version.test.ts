import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultSkill,
  getSkillVersion,
  jsonBody,
  postSkillVersion,
  skillForm,
  skillMd,
  type ErrorEnvelope,
  type SkillVersionJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("GET /v1/skills/{skillId}/versions/{version}", () => {
  it("多版本 Skill 逐版本读取,元数据与当时上传一致", async () => {
    const skill = await createDefaultSkill({ "SKILL.md": skillMd("v1-skill", "First.") });
    await postSkillVersion(
      skill.id,
      skillForm({ "tools/SKILL.md": skillMd("v2-skill", "Second.") }),
    );
    const first = await getSkillVersion(skill.id, "1");
    expect(first.status).toBe(200);
    const firstBody = await jsonBody<SkillVersionJson>(first);
    expect(firstBody.name).toBe("v1-skill");
    expect(firstBody.description).toBe("First.");
    expect(firstBody.directory).toBe("v1-skill"); // 无前缀 → directory = name
    expect(firstBody.version).toBe("1");
    const second = await jsonBody<SkillVersionJson>(await getSkillVersion(skill.id, "2"));
    expect(second.name).toBe("v2-skill");
    expect(second.directory).toBe("tools");
    expect(second.created_at).not.toBe(firstBody.created_at);
  });

  it("version=01 / 1a 非法形态返回 400", async () => {
    const skill = await createDefaultSkill();
    expect((await getSkillVersion(skill.id, "01")).status).toBe(400);
    expect((await getSkillVersion(skill.id, "1a")).status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(await getSkillVersion(skill.id, "01"));
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("不存在的版本返回 404;不存在的 Skill 同样 404", async () => {
    const skill = await createDefaultSkill();
    expect((await getSkillVersion(skill.id, "9")).status).toBe(404);
    expect((await getSkillVersion("skill_01911111-0000-7000-8000-000000000000", "1")).status).toBe(404);
  });

  it("不带凭证返回 401", async () => {
    const skill = await createDefaultSkill();
    expect((await getSkillVersion(skill.id, "1", { Authorization: "" })).status).toBe(401);
  });
});
