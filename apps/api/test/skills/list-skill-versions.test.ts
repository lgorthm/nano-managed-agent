import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDefaultSkill,
  type ErrorEnvelope,
  jsonBody,
  listSkills,
  listSkillVersions,
  type PageJson,
  postSkillVersion,
  type SkillVersionJson,
  skillForm,
  skillMd,
} from './helpers';

beforeAll(applyMigrations);

/** 造一个有 3 个版本的 Skill */
async function threeVersionSkill(): Promise<string> {
  const skill = await createDefaultSkill({
    'SKILL.md': skillMd('hist-skill', 'v1'),
  });
  await postSkillVersion(skill.id, skillForm({ 'SKILL.md': skillMd('hist-skill', 'v2') }));
  await postSkillVersion(skill.id, skillForm({ 'SKILL.md': skillMd('hist-skill', 'v3') }));
  return skill.id;
}

describe('GET /v1/skills/{skillId}/versions', () => {
  it('三个版本默认倒序 3、2、1', async () => {
    const skillId = await threeVersionSkill();
    const page = await jsonBody<PageJson<SkillVersionJson>>(await listSkillVersions(skillId));
    expect(page.data.map((version) => version.version)).toEqual(['3', '2', '1']);
  });

  it('order=asc 正序;游标翻页', async () => {
    const skillId = await threeVersionSkill();
    const asc = await jsonBody<PageJson<SkillVersionJson>>(
      await listSkillVersions(skillId, '?order=asc'),
    );
    expect(asc.data.map((version) => version.version)).toEqual(['1', '2', '3']);

    const first = await jsonBody<PageJson<SkillVersionJson>>(
      await listSkillVersions(skillId, '?limit=2'),
    );
    expect(first.data.map((version) => version.version)).toEqual(['3', '2']);
    const second = await jsonBody<PageJson<SkillVersionJson>>(
      await listSkillVersions(skillId, `?limit=2&page=${encodeURIComponent(first.next_page!)}`),
    );
    expect(second.data.map((version) => version.version)).toEqual(['1']);
    expect(second.next_page).toBeNull();
  });

  it('把 list-skills 的游标传入返回 400(kind 防混用)', async () => {
    const skillId = await threeVersionSkill();
    const skillsPage = await jsonBody<PageJson<unknown>>(await listSkills('?limit=1'));
    const res = await listSkillVersions(
      skillId,
      `?page=${encodeURIComponent(skillsPage.next_page!)}`,
    );
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe('invalid_request_error');
  });

  it('limit=0 返回 400;不带凭证返回 401;不存在的 Skill 返回 404', async () => {
    const skillId = await threeVersionSkill();
    expect((await listSkillVersions(skillId, '?limit=0')).status).toBe(400);
    expect((await listSkillVersions(skillId, '', { Authorization: '' })).status).toBe(401);
    expect((await listSkillVersions('skill_01911111-0000-7000-8000-000000000000')).status).toBe(
      404,
    );
  });
});
