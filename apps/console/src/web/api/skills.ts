import type {
  ListQuery,
  Skill,
  SkillCreateInput,
  SkillDeleted,
  SkillListQuery,
  SkillPage,
  SkillVersion,
  SkillVersionDeleted,
} from "@nano/shared/glm";
import { filenameFromDisposition, glmFetch, glmFetchPage, glmFetchRaw, qs } from "./client";

const BASE = "/agent/managed/v1/skills";

export function listSkills(query: SkillListQuery = {}) {
  return glmFetch<SkillPage>(`${BASE}${qs(query)}`);
}

export function getSkill(skillId: string) {
  return glmFetch<Skill>(`${BASE}/${skillId}`);
}

export function listSkillVersions(skillId: string, query: ListQuery = {}) {
  return glmFetchPage<SkillVersion>(`${BASE}/${skillId}/versions`, query);
}

export function getSkillVersion(skillId: string, version: string) {
  return glmFetch<SkillVersion>(`${BASE}/${skillId}/versions/${version}`);
}

function buildUploadForm(input: SkillCreateInput): FormData {
  const form = new FormData();
  if (input.displayTitle) form.set("display_title", input.displayTitle);
  // 字段名是 Skill 内相对路径;filename 同步为 path,服务端按字段名归一化
  for (const { path, file } of input.files) form.set(path, file, path);
  return form;
}

/** multipart 上传完整目录,创建 Skill 与首个版本(v1) */
export function createSkill(input: SkillCreateInput) {
  return glmFetch<Skill>(BASE, { method: "POST", body: buildUploadForm(input) });
}

/** 重新上传完整目录生成新版本;不接受任何文本字段 */
export function createSkillVersion(skillId: string, input: Omit<SkillCreateInput, "displayTitle">) {
  return glmFetch<SkillVersion>(`${BASE}/${skillId}/versions`, {
    method: "POST",
    body: buildUploadForm(input),
  });
}

/** 下载版本 ZIP;GLM 可能不带 content-disposition,调用方提供兜底文件名 */
export async function downloadSkillZip(skillId: string, version: string, fallbackName: string) {
  const res = await glmFetchRaw(`${BASE}/${skillId}/versions/${version}/content`);
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get("content-disposition")) ?? fallbackName,
  };
}

export function deleteSkill(skillId: string) {
  return glmFetch<SkillDeleted>(`${BASE}/${skillId}`, { method: "DELETE" });
}

export function deleteSkillVersion(skillId: string, version: string) {
  return glmFetch<SkillVersionDeleted>(`${BASE}/${skillId}/versions/${version}`, {
    method: "DELETE",
  });
}
