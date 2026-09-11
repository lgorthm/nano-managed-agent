import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultSkill,
  jsonBody,
  listSkills,
  skillForm,
  skillMd,
  type ErrorEnvelope,
  type PageJson,
  type SkillJson,
} from "./helpers";

beforeAll(applyMigrations);

describe("GET /v1/skills 分页与排序", () => {
  it("默认参数返回 20 条、按创建时间倒序、next_page 非空", async () => {
    for (let i = 0; i < 25; i++) {
      await createDefaultSkill({ "SKILL.md": skillMd(`bulk-skill-${i}`) });
    }
    const res = await listSkills();
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<SkillJson>>(res);
    expect(page.data).toHaveLength(20);
    expect(page.next_page).toBeTruthy();
    const createdAts = page.data.map((skill) => skill.created_at);
    const sorted = [...createdAts].sort().reverse();
    expect(createdAts).toEqual(sorted);
  });

  it("携带游标翻到下一页,取到剩余 5 条且 next_page 为 null", async () => {
    const first = await jsonBody<PageJson<SkillJson>>(await listSkills());
    const second = await jsonBody<PageJson<SkillJson>>(
      await listSkills(`?page=${encodeURIComponent(first.next_page!)}`),
    );
    expect(second.data).toHaveLength(5);
    expect(second.next_page).toBeNull();
    // 两页无交集
    const ids = new Set([...first.data, ...second.data].map((skill) => skill.id));
    expect(ids.size).toBe(25);
  });

  it("limit=5 生效;limit=200 截断为 100;limit=0 返回 400", async () => {
    expect((await jsonBody<PageJson<SkillJson>>(await listSkills("?limit=5"))).data).toHaveLength(5);
    const res = await listSkills("?limit=200");
    expect(res.status).toBe(200);
    expect((await jsonBody<PageJson<SkillJson>>(res)).data.length).toBeLessThanOrEqual(100);
    expect((await listSkills("?limit=0")).status).toBe(400);
  });

  it("order=asc 正序", async () => {
    const page = await jsonBody<PageJson<SkillJson>>(await listSkills("?order=asc&limit=5"));
    const createdAts = page.data.map((skill) => skill.created_at);
    expect(createdAts).toEqual([...createdAts].sort());
  });

  it("篡改游标内容返回 400", async () => {
    const res = await listSkills("?page=not-a-cursor");
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("invalid_request_error");
  });

  it("agents 的游标传入返回 400(kind 防混用)", async () => {
    // agents kind 的合法 base64url 游标,但 kind 与 skills 不匹配
    const foreign = btoa(JSON.stringify({ kind: "agents", createdAt: 1, id: "x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect((await listSkills(`?page=${foreign}`)).status).toBe(400);
  });
});

describe("GET /v1/skills source 过滤", () => {
  it("source=custom 返回全部(当前均为 custom)", async () => {
    const page = await jsonBody<PageJson<SkillJson>>(await listSkills("?source=custom&limit=1"));
    expect(page.data.every((skill) => skill.source === "custom")).toBe(true);
  });

  it("source=zai 返回空页(无平台内置 Skill)", async () => {
    const res = await listSkills("?source=zai");
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<SkillJson>>(res);
    expect(page.data).toEqual([]);
    expect(page.next_page).toBeNull();
  });

  it("source 非法返回 400", async () => {
    expect((await listSkills("?source=other")).status).toBe(400);
  });
});
