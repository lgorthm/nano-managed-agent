/**
 * SKILL.md frontmatter 解析(docs/skills/schema.md 的「规范树」一节):
 * 只提取 name 与 description 两个键做校验,其余键(如 allowed-tools)原样留在文件内容里。
 * 刻意不引入完整 YAML 库——这两个键都是单行标量,行级解析足够,
 * 也避免把任意 YAML 解析的攻击面带进 Worker。
 */

/** frontmatter name 的合法形态:小写字母数字与连字符,首字符不为连字符,≤ 64 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** frontmatter description 长度上限 */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export type FrontmatterErrorCode =
  | 'missing_frontmatter'
  | 'missing_name'
  | 'missing_description'
  | 'invalid_name'
  | 'invalid_description';

export interface FrontmatterError {
  code: FrontmatterErrorCode;
  message: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export type ParseSkillFrontmatterResult =
  | { ok: true; data: SkillFrontmatter }
  | { ok: false; error: FrontmatterError };

function error(code: FrontmatterErrorCode, message: string): ParseSkillFrontmatterResult {
  return { ok: false, error: { code, message } };
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter(--- 围起)。
 * 键匹配 `key: value` 形态;无法解析的行忽略,但 name / description 必须存在且合法。
 */
export function parseSkillFrontmatter(bytes: Uint8Array): ParseSkillFrontmatterResult {
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    return error('missing_frontmatter', 'SKILL.md must start with a YAML frontmatter block (---).');
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing === -1) {
    return error('missing_frontmatter', 'SKILL.md frontmatter block is not closed.');
  }

  const entries = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (match) {
      entries.set(match[1] as string, (match[2] as string).trim());
    }
  }

  const name = entries.get('name');
  if (name === undefined || name === '') {
    return error('missing_name', 'Frontmatter must provide a "name" key.');
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return error(
      'invalid_name',
      `Frontmatter "name" ("${name}") must match ${SKILL_NAME_PATTERN.source}.`,
    );
  }

  const description = entries.get('description');
  if (description === undefined || description === '') {
    return error('missing_description', 'Frontmatter must provide a "description" key.');
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return error(
      'invalid_description',
      `Frontmatter "description" exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    );
  }

  return { ok: true, data: { name, description } };
}
