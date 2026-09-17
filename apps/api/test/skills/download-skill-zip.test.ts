import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createDefaultSkill,
  downloadSkillZip,
  type ErrorEnvelope,
  jsonBody,
  postSkillVersion,
  skillForm,
  skillMd,
} from './helpers';

beforeAll(applyMigrations);

const SKILL_MD_BODY = '---\nname: zip-skill\ndescription: Zip round-trip.\n---\n\n# Zip\n';
const RUN_PY = "print('hi')\n";

/** 一个带子目录两文件的版本 */
async function skillWithFiles(): Promise<{ id: string; latest: string }> {
  const skill = await createDefaultSkill({
    'SKILL.md': SKILL_MD_BODY,
    'scripts/run.py': RUN_PY,
    'scripts/sub/deep.txt': 'deep\n',
  });
  return { id: skill.id, latest: skill.latest_version! };
}

function unzipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

describe('GET /v1/skills/{skillId}/versions/{version}/content', () => {
  it('下载解压后根目录为 <directory>/,每个条目字节与上传一致', async () => {
    const { id, latest } = await skillWithFiles();
    const res = await downloadSkillZip(id, latest);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="zip-skill-v1.zip"');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const entries = unzipEntries(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      'zip-skill/SKILL.md',
      'zip-skill/scripts/run.py',
      'zip-skill/scripts/sub/deep.txt',
    ]);
    expect(strFromU8(entries['zip-skill/SKILL.md']!)).toBe(SKILL_MD_BODY);
    expect(strFromU8(entries['zip-skill/scripts/run.py']!)).toBe(RUN_PY);
    expect(strFromU8(entries['zip-skill/scripts/sub/deep.txt']!)).toBe('deep\n');
  });

  it('带单根前缀上传的版本,directory 为前缀名', async () => {
    const skill = await createDefaultSkill({
      'pdf-tools/SKILL.md': skillMd('pdf-processing'),
      'pdf-tools/scripts/x.py': 'x',
    });
    const res = await downloadSkillZip(skill.id, '1');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pdf-tools-v1.zip"');
    const entries = unzipEntries(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries)).toContain('pdf-tools/SKILL.md');
  });

  it('同一版本两次下载字节完全一致(确定性),ETag 稳定', async () => {
    const { id, latest } = await skillWithFiles();
    const first = new Uint8Array(await (await downloadSkillZip(id, latest)).arrayBuffer());
    const secondRes = await downloadSkillZip(id, latest);
    const second = new Uint8Array(await secondRes.arrayBuffer());
    expect([...second]).toEqual([...first]);
    expect(secondRes.headers.get('etag')).toBe(
      (await downloadSkillZip(id, latest)).headers.get('etag'),
    );
  });

  it('内容变化后 ETag 变化;旧版本内容不变', async () => {
    const { id } = await skillWithFiles();
    await postSkillVersion(id, skillForm({ 'SKILL.md': skillMd('zip-skill', 'Changed.') }));
    const v1 = await downloadSkillZip(id, '1');
    const v2 = await downloadSkillZip(id, '2');
    expect(v1.headers.get('etag')).not.toBe(v2.headers.get('etag'));
    const entries = unzipEntries(new Uint8Array(await v1.arrayBuffer()));
    expect(strFromU8(entries['zip-skill/SKILL.md']!)).toBe(SKILL_MD_BODY);
  });

  it('version 非法形态 400;不存在的版本 404;不带凭证 401', async () => {
    const { id } = await skillWithFiles();
    expect((await downloadSkillZip(id, '01')).status).toBe(400);
    expect((await downloadSkillZip(id, '9')).status).toBe(404);
    expect((await downloadSkillZip(id, '1', { Authorization: '' })).status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(await downloadSkillZip(id, '9'));
    expect(envelope.error.type).toBe('not_found_error');
  });
});
