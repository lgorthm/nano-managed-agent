import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { createSkill } from './handlers/create-skill';
import { createSkillVersion } from './handlers/create-skill-version';
import { deleteSkill } from './handlers/delete-skill';
import { deleteSkillVersion } from './handlers/delete-skill-version';
import { downloadSkillZip } from './handlers/download-skill-zip';
import { getSkill } from './handlers/get-skill';
import { getSkillVersion } from './handlers/get-skill-version';
import { listSkillVersions } from './handlers/list-skill-versions';
import { listSkills } from './handlers/list-skills';

/** Skill 资源子路由;端点与 docs/skills/api/*.md 一一对应 */
export const skillRoutes = new Hono<AppEnv>();

skillRoutes.post('/', createSkill);
skillRoutes.get('/', listSkills);
// content 路径更长,先注册避免被 :version 捕获(Hono 按段落精确匹配,顺序上仍有讲究)
skillRoutes.get('/:skillId/versions/:version/content', downloadSkillZip);
skillRoutes.get('/:skillId/versions/:version', getSkillVersion);
skillRoutes.delete('/:skillId/versions/:version', deleteSkillVersion);
skillRoutes.get('/:skillId/versions', listSkillVersions);
skillRoutes.post('/:skillId/versions', createSkillVersion);
skillRoutes.delete('/:skillId', deleteSkill);
skillRoutes.get('/:skillId', getSkill);
