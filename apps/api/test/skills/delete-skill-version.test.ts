import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultSkill,
  deleteSkillVersion,
  getSkill,
  jsonBody,
  postAgent,
  postSkillVersion,
  readSkillRowInDb,
  skillForm,
  skillMd,
  updateAgent,
  type ErrorEnvelope,
  type SkillJson,
} from "./helpers";

beforeAll(applyMigrations);

/** 引用指定 Skill 版本的 Agent payload(skills 非空时必须含内置工具集) */
function agentBody(skillId: string, version: string): Record<string, unknown> {
  return {
    name: "ref-agent",
    model: "glm-5.3",
    tools: [{ type: "agent_toolset_20260601" }],
    skills: [{ type: "custom", skill_id: skillId, version }],
  };
}

/** 造一个有 3 个版本的 Skill */
async function threeVersionSkill(): Promise<string> {
  const skill = await createDefaultSkill({ "SKILL.md": skillMd("del-skill", "v1") });
  await postSkillVersion(skill.id, skillForm({ "SKILL.md": skillMd("del-skill", "v2") }));
  await postSkillVersion(skill.id, skillForm({ "SKILL.md": skillMd("del-skill", "v3") }));
  return skill.id;
}

describe("DELETE /v1/skills/{skillId}/versions/{version} 指针重指", () => {
  it("删非最新版本,latest_version 不变", async () => {
    const skillId = await threeVersionSkill();
    const res = await deleteSkillVersion(skillId, "2");
    expect(res.status).toBe(200);
    const skill = await jsonBody<SkillJson>(await getSkill(skillId));
    expect(skill.latest_version).toBe("3");
  });

  it("删最新版本,指针落到剩余最大版本", async () => {
    const skillId = await threeVersionSkill();
    expect((await deleteSkillVersion(skillId, "3")).status).toBe(200);
    const skill = await jsonBody<SkillJson>(await getSkill(skillId));
    expect(skill.latest_version).toBe("2");
  });

  it("删到零个版本成为空壳:latest_version 为 null,仍可获取", async () => {
    const skillId = await threeVersionSkill();
    for (const version of ["3", "2", "1"]) {
      expect((await deleteSkillVersion(skillId, version)).status).toBe(200);
    }
    const skill = await jsonBody<SkillJson>(await getSkill(skillId));
    expect(skill.latest_version).toBeNull();
    expect(skill.type).toBe("skill");
  });

  it("删除回执携带版本的 skv_ ID", async () => {
    const skillId = await threeVersionSkill();
    const body = await jsonBody<{ id: string; type: string }>(await deleteSkillVersion(skillId, "1"));
    expect(body.type).toBe("skill_version_deleted");
    expect(body.id).toMatch(/^skv_/);
  });
});

describe("DELETE /v1/skills/{skillId}/versions/{version} 引用保护", () => {
  it("被 Agent 引用的版本删除返回 400", async () => {
    const skillId = await threeVersionSkill();
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skillId, "2")));
    const res = await deleteSkillVersion(skillId, "2");
    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("referenced");
  });

  it("Agent 历史快照中的引用不阻止删除(只有活动配置阻止)", async () => {
    const skillId = await threeVersionSkill();
    // v1 引用 skill@2;随后更新 Agent 清空 skills——当前版本不再引用,历史快照保留引用
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skillId, "2")));
    await updateAgent(agent.id, { skills: null });
    const res = await deleteSkillVersion(skillId, "2");
    expect(res.status).toBe(200);
  });

  it("更新 Agent 解除引用后可删", async () => {
    const skillId = await threeVersionSkill();
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skillId, "2")));
    await updateAgent(agent.id, { skills: [] });
    expect((await deleteSkillVersion(skillId, "2")).status).toBe(200);
  });
});

describe("DELETE /v1/skills/{skillId}/versions/{version} 错误路径", () => {
  it("version 非法形态 400;不存在的版本 404;重复删除 404", async () => {
    const skillId = await threeVersionSkill();
    expect((await deleteSkillVersion(skillId, "01")).status).toBe(400);
    expect((await deleteSkillVersion(skillId, "9")).status).toBe(404);
    expect((await deleteSkillVersion(skillId, "1")).status).toBe(200);
    expect((await deleteSkillVersion(skillId, "1")).status).toBe(404);
  });

  it("不存在的 Skill 404;不带凭证 401", async () => {
    expect((await deleteSkillVersion("skill_01911111-0000-7000-8000-000000000000", "1")).status).toBe(404);
    const skillId = await threeVersionSkill();
    expect((await deleteSkillVersion(skillId, "1", { Authorization: "" })).status).toBe(401);
  });

  it("删除后文件行同批清除(直查库无残留)", async () => {
    const skillId = await threeVersionSkill();
    await deleteSkillVersion(skillId, "1");
    const row = await (await import("cloudflare:workers")).env.DB.prepare(
      "SELECT COUNT(*) AS n FROM skill_files WHERE skill_id = ? AND version = 1",
    ).bind(skillId).first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect((await readSkillRowInDb(skillId))?.next_version).toBe(4); // 分配器不复用
  });
});
