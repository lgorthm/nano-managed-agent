import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  countSkillRowsInDb,
  createDefaultSkill,
  deleteSkill,
  deleteSkillVersion,
  downloadSkillZip,
  type ErrorEnvelope,
  getSkill,
  getSkillVersion,
  jsonBody,
  listSkillVersions,
  postAgent,
  postSkillVersion,
  skillForm,
  skillMd,
  updateAgent,
} from './helpers';

beforeAll(applyMigrations);

async function multiVersionSkill(): Promise<string> {
  const skill = await createDefaultSkill({
    'SKILL.md': skillMd('gone-skill', 'v1'),
  });
  await postSkillVersion(skill.id, skillForm({ 'SKILL.md': skillMd('gone-skill', 'v2') }));
  return skill.id;
}

describe('DELETE /v1/skills/{skillId} 成功路径', () => {
  it('删除后获取 404、版本列表 404、下载 404', async () => {
    const skillId = await multiVersionSkill();
    const res = await deleteSkill(skillId);
    expect(res.status).toBe(200);
    expect(await jsonBody<{ id: string; type: string }>(res)).toEqual({
      id: skillId,
      type: 'skill_deleted',
    });
    expect((await getSkill(skillId)).status).toBe(404);
    expect((await listSkillVersions(skillId)).status).toBe(404);
    expect((await downloadSkillZip(skillId, '1')).status).toBe(404);
    expect((await getSkillVersion(skillId, '2')).status).toBe(404);
  });

  it('多版本 Skill 删除后三张表均无残留', async () => {
    const skillId = await multiVersionSkill();
    await deleteSkill(skillId);
    expect(await countSkillRowsInDb(skillId)).toEqual({
      skills: 0,
      versions: 0,
      files: 0,
    });
  });

  it('删除单版本 Skill 后再删除空壳 Skill 也可成功', async () => {
    const skill = await createDefaultSkill();
    await deleteSkillVersion(skill.id, '1');
    expect((await deleteSkill(skill.id)).status).toBe(200);
  });
});

describe('DELETE /v1/skills/{skillId} 引用保护', () => {
  it('被任意版本引用时返回 400', async () => {
    const skillId = await multiVersionSkill();
    const agent = await jsonBody<{ id: string }>(
      await postAgent({
        name: 'ref-agent',
        model: 'glm-5.3',
        tools: [{ type: 'agent_toolset_20260601' }],
        skills: [{ type: 'custom', skill_id: skillId, version: '1' }],
      }),
    );
    const res = await deleteSkill(skillId);
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain('referenced');
    expect((await countSkillRowsInDb(skillId)).skills).toBe(1); // 未被删除
    void agent;
  });

  it('解除引用后可删', async () => {
    const skillId = await multiVersionSkill();
    const agent = await jsonBody<{ id: string }>(
      await postAgent({
        name: 'ref-agent-2',
        model: 'glm-5.3',
        tools: [{ type: 'agent_toolset_20260601' }],
        skills: [{ type: 'custom', skill_id: skillId, version: '2' }],
      }),
    );
    await updateAgent(agent.id, { skills: null });
    expect((await deleteSkill(skillId)).status).toBe(200);
  });
});

describe('DELETE /v1/skills/{skillId} 错误路径', () => {
  it('不存在的 Skill 404;重复删除 404;不带凭证 401', async () => {
    expect((await deleteSkill('skill_01911111-0000-7000-8000-000000000000')).status).toBe(404);
    const skillId = await multiVersionSkill();
    expect((await deleteSkill(skillId)).status).toBe(200);
    expect((await deleteSkill(skillId)).status).toBe(404);
    const another = await multiVersionSkill();
    expect((await deleteSkill(another, { Authorization: '' })).status).toBe(401);
  });
});
