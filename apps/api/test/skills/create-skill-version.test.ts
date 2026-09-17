import { env, exports } from 'cloudflare:workers';
import { findSkill, getDb, insertNextSkillVersionAndAdvance } from '@nano/db';
import { normalizeSkillTree } from '@nano/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDefaultSkill,
  type ErrorEnvelope,
  getSkill,
  jsonBody,
  postSkillVersion,
  readSkillRowInDb,
  type SkillJson,
  type SkillVersionJson,
  skillForm,
  skillMd,
} from './helpers';

beforeAll(applyMigrations);

/** 两文件 + 前缀的版本上传形态 */
function versionForm(name = 'demo-skill', description = 'Updated.') {
  return skillForm({
    'pdf-tools/SKILL.md': skillMd(name, description),
    'pdf-tools/scripts/run.py': "print('v2')\n",
  });
}

describe('POST /v1/skills/{skillId}/versions 成功路径', () => {
  it('连续上传两次,版本号 2、3 递增,latest_version 前移', async () => {
    const skill = await createDefaultSkill();
    const secondRes = await postSkillVersion(skill.id, versionForm());
    expect(secondRes.status).toBe(201);
    const second = await jsonBody<SkillVersionJson>(secondRes);
    const third = await jsonBody<SkillVersionJson>(await postSkillVersion(skill.id, versionForm()));
    const afterThird = await jsonBody<SkillJson>(await getSkill(skill.id));
    expect(second.version).toBe('2');
    expect(third.version).toBe('3');
    expect(afterThird.latest_version).toBe('3');
    expect(second.skill_id).toBe(skill.id);
    expect(second.type).toBe('skill_version');
    expect(second.id).toMatch(/^skv_[0-9a-f-]{36}$/);
    expect(second.directory).toBe('pdf-tools');
  });

  it('frontmatter 变化体现在新版本元数据(经 get-skill-version 验证)', async () => {
    const skill = await createDefaultSkill();
    const uploaded = await jsonBody<SkillVersionJson>(
      await postSkillVersion(skill.id, versionForm('renamed-skill', 'New description.')),
    );
    const fetched = await jsonBody<SkillVersionJson>(
      await exports.default.fetch(
        `http://example.com/v1/skills/${skill.id}/versions/${uploaded.version}`,
        { headers: { Authorization: 'Bearer dev-key-change-me' } },
      ),
    );
    expect(fetched.name).toBe('renamed-skill');
    expect(fetched.description).toBe('New description.');
  });

  it('重复上传相同内容也生成新版本(不去重)', async () => {
    const skill = await createDefaultSkill();
    const form = versionForm();
    await postSkillVersion(skill.id, form);
    const third = await postSkillVersion(skill.id, skillForm({ 'SKILL.md': skillMd() }));
    expect(third.status).toBe(201);
    expect((await jsonBody<SkillVersionJson>(third)).version).toBe('3');
  });

  it('空壳 Skill(版本删空)可继续上传,版本号从分配器当前值递增', async () => {
    const skill = await createDefaultSkill();
    // 造两个版本再全部删掉:直接用接口删(无 Agent 引用,可删)
    await postSkillVersion(skill.id, versionForm());
    const _db = getDb(env);
    const v1 = await exports.default.fetch(`http://example.com/v1/skills/${skill.id}/versions/1`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev-key-change-me' },
    });
    expect(v1.status).toBe(200);
    await exports.default.fetch(`http://example.com/v1/skills/${skill.id}/versions/2`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev-key-change-me' },
    });
    const shell = await jsonBody<SkillJson>(await getSkill(skill.id));
    expect(shell.latest_version).toBeNull();
    const next = await jsonBody<SkillVersionJson>(await postSkillVersion(skill.id, versionForm()));
    expect(next.version).toBe('3'); // 不复用 1、2
    expect((await readSkillRowInDb(skill.id))?.next_version).toBe(4);
  });
});

describe('POST /v1/skills/{skillId}/versions 错误路径', () => {
  it('不存在的 Skill 返回 404', async () => {
    const res = await postSkillVersion('skill_01911111-0000-7000-8000-000000000000', versionForm());
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe('not_found_error');
  });

  it('携带任何文本字段返回 400', async () => {
    const skill = await createDefaultSkill();
    const form = skillForm({ 'SKILL.md': skillMd() }, { display_title: '不允许' });
    const res = await postSkillVersion(skill.id, form);
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.message).toContain(
      'Unknown multipart text field',
    );
  });

  it('缺 SKILL.md 返回 400', async () => {
    const skill = await createDefaultSkill();
    expect((await postSkillVersion(skill.id, skillForm({ 'scripts/x.py': 'x' }))).status).toBe(400);
  });

  it('不带凭证返回 401', async () => {
    const skill = await createDefaultSkill();
    const res = await postSkillVersion(skill.id, versionForm(), {
      Authorization: '',
    });
    expect(res.status).toBe(401);
  });
});

describe('版本号分配的并发安全(CAS)', () => {
  it('repo 层:expectedVersion 过期时返回 false 且不留孤儿行', async () => {
    const skill = await createDefaultSkill();
    const db = getDb(env);
    const row = await findSkill(db, skill.id);
    expect(row).not.toBeNull();
    const tree = await normalizeSkillTree([
      { path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd()) },
    ]);
    expect(tree.ok).toBe(true);
    if (!row || !tree.ok) return;
    const advanced = await insertNextSkillVersionAndAdvance(db, {
      skillId: skill.id,
      expectedVersion: row.nextVersion + 5, // 已被并发上传抢走的位置
      versionId: 'skv_00000000-0000-7000-8000-000000000000',
      meta: { name: 'x', description: 'x', directory: 'x' },
      tree: tree.tree,
      now: new Date(),
    });
    expect(advanced).toBe(false);
    const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM skill_files WHERE skill_id = ?')
      .bind(skill.id)
      .first<{ n: number }>();
    expect(files?.n).toBe(1); // 仍只有版本 1 的 SKILL.md
  });

  it('并行两次上传:版本号互不重复,不出现 500', async () => {
    const skill = await createDefaultSkill();
    const results = await Promise.all([
      postSkillVersion(skill.id, versionForm()),
      postSkillVersion(skill.id, skillForm({ 'SKILL.md': skillMd('parallel-b') })),
    ]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    const bodies = await Promise.all(
      results.map(async (res) =>
        res.status === 201 ? await jsonBody<SkillVersionJson>(res) : null,
      ),
    );
    const versions = bodies.filter((body) => body !== null).map((body) => body!.version);
    expect(new Set(versions).size).toBe(versions.length);
    // 无论竞态如何落点,库内指针与分配器保持一致
    const row = await readSkillRowInDb(skill.id);
    expect(row).not.toBeNull();
    expect(row!.next_version).toBeGreaterThanOrEqual(3);
    expect(row!.latest_version_seq).toBe(row!.next_version - 1);
  });
});
