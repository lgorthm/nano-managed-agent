import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultSkill,
  deleteSkillVersion,
  jsonBody,
  postAgent,
  postSkillVersion,
  skillForm,
  skillMd,
  updateAgent,
  type ErrorEnvelope,
} from "../skills/helpers";

beforeAll(applyMigrations);

/** 引用 Skill 的 Agent payload(skills 非空时必须含内置工具集) */
function agentBody(skillId: string, version: string): Record<string, unknown> {
  return {
    name: "skill-ref-agent",
    model: "glm-5.3",
    tools: [{ type: "agent_toolset_20260601" }],
    skills: [{ type: "custom", skill_id: skillId, version }],
  };
}

describe("Agent 创建时的 Skill 引用存在性校验", () => {
  it("引用不存在的 skill 返回 400", async () => {
    const res = await postAgent(agentBody("skill_01911111-0000-7000-8000-000000000000", "1"));
    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("not resolvable");
  });

  it("引用存在 skill 的不存在版本返回 400", async () => {
    const skill = await createDefaultSkill();
    const res = await postAgent(agentBody(skill.id, "9"));
    expect(res.status).toBe(400);
  });

  it('引用 type: "zai" 返回 400(nano 无平台内置 Skill)', async () => {
    const res = await postAgent({
      name: "zai-ref-agent",
      model: "glm-5.3",
      tools: [{ type: "agent_toolset_20260601" }],
      skills: [{ type: "zai", skill_id: "whatever", version: "1" }],
    });
    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorEnvelope>(res);
    expect(body.error.message).toContain("zai");
  });

  it("合法引用(先建 Skill 再建 Agent)返回 201", async () => {
    const skill = await createDefaultSkill();
    const res = await postAgent(agentBody(skill.id, "1"));
    expect(res.status).toBe(201);
    const body = await jsonBody<{ skills: unknown[] }>(res);
    expect(body.skills).toEqual([{ type: "custom", skill_id: skill.id, version: "1" }]);
  });

  it("不带 skills 的 Agent 不受影响", async () => {
    const res = await postAgent({ name: "no-skill-agent", model: "glm-5.3" });
    expect(res.status).toBe(201);
  });
});

describe("Agent 更新时的 Skill 引用存在性校验", () => {
  it("提交的 skills 引用不可解析返回 400", async () => {
    const skill = await createDefaultSkill();
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skill.id, "1")));
    const res = await updateAgent(agent.id, {
      skills: [{ type: "custom", skill_id: skill.id, version: "42" }],
    });
    expect(res.status).toBe(400);
  });

  it("未提交 skills 字段时不触发校验(引用保持现状)", async () => {
    const skill = await createDefaultSkill();
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skill.id, "1")));
    // 引用的版本先被删掉(绕过:当前 Agent 不再活动时才可能;这里直接归档前验证未提交字段的更新仍可用)
    const res = await updateAgent(agent.id, { description: "只改描述" });
    expect(res.status).toBe(200);
  });

  it("提交 skills: [] 清空后,删除保护随之解除(与 delete-skill-version 用例互为闭环)", async () => {
    const skill = await createDefaultSkill();
    await postSkillVersion(skill.id, skillForm({ "SKILL.md": skillMd("unblock", "v2") }));
    const agent = await jsonBody<{ id: string }>(await postAgent(agentBody(skill.id, "2")));
    expect((await deleteSkillVersion(skill.id, "2")).status).toBe(400);
    expect((await updateAgent(agent.id, { skills: [] })).status).toBe(200);
    expect((await deleteSkillVersion(skill.id, "2")).status).toBe(200);
  });
});
