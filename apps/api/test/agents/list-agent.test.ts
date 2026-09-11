import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  archiveAgentInDb,
  createDefaultAgent,
  jsonBody,
  listAgents,
  type AgentJson,
  type ErrorEnvelope,
  type PageJson,
} from "./helpers";

beforeAll(applyMigrations);

/** keyset 排序键:ISO 时间戳 + id 的字典序拼接,可直接字符串比较 */
function cursorKey(agent: AgentJson): string {
  return `${agent.created_at}|${agent.id}`;
}

function isSorted(items: AgentJson[], order: "asc" | "desc"): boolean {
  return items.every((item, i) => {
    if (i === 0) return true;
    const diff = cursorKey(items[i - 1]!).localeCompare(cursorKey(item));
    return order === "desc" ? diff >= 0 : diff <= 0;
  });
}

async function createBatch(prefix: string, count: number): Promise<AgentJson[]> {
  const created: AgentJson[] = [];
  for (let i = 0; i < count; i++) {
    created.push(await createDefaultAgent({ name: `${prefix}-${String(i).padStart(3, "0")}`, model: "glm-5.3" }));
  }
  return created;
}

// 本文件内测试按声明顺序执行,游标翻页用例必须先于批量造数用例,
// 否则"翻完所有页恰好 25 条"的断言会被后续用例创建的数据破坏。
describe("GET /v1/agents 默认分页与游标往返", () => {
  it("25 个 Agent:默认 20 条倒序,翻页取完剩余 5 条且 next_page 为 null", async () => {
    const created = await createBatch("page", 25);
    const createdIds = new Set(created.map((a) => a.id));

    const first = await jsonBody<PageJson<AgentJson>>(await listAgents());
    expect(first.data).toHaveLength(20);
    expect(first.next_page).toBeTruthy();
    expect(isSorted(first.data, "desc")).toBe(true);

    const second = await jsonBody<PageJson<AgentJson>>(await listAgents(`?page=${first.next_page}`));
    expect(second.data).toHaveLength(5);
    expect(second.next_page).toBeNull();
    expect(isSorted(second.data, "desc")).toBe(true);

    const collected = [...first.data, ...second.data];
    expect(new Set(collected.map((a) => a.id))).toEqual(createdIds);
  });

  it("limit=5 生效且游标连续翻页不重不漏", async () => {
    const page1 = await jsonBody<PageJson<AgentJson>>(await listAgents("?limit=5"));
    expect(page1.data).toHaveLength(5);
    const page2 = await jsonBody<PageJson<AgentJson>>(await listAgents(`?limit=5&page=${page1.next_page}`));
    expect(page2.data).toHaveLength(5);
    const ids1 = new Set(page1.data.map((a) => a.id));
    for (const item of page2.data) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });
});

describe("GET /v1/agents 参数校验与截断", () => {
  it("limit=200 被截断为 100", async () => {
    // 库中已有 30 个,再造 105 个确保超过 100;恰好返回 100 条证明截断生效
    await createBatch("bulk", 105);
    const page = await jsonBody<PageJson<AgentJson>>(await listAgents("?limit=200"));
    expect(page.data).toHaveLength(100);
    expect(page.next_page).toBeTruthy();
  });

  it("order=asc 正序", async () => {
    const page = await jsonBody<PageJson<AgentJson>>(await listAgents("?order=asc&limit=100"));
    expect(page.data.length).toBeGreaterThan(0);
    expect(isSorted(page.data, "asc")).toBe(true);
  });

  it("limit=0、limit 非数字、order 非法分别返回 400", async () => {
    for (const query of ["?limit=0", "?limit=abc", "?order=bogus"]) {
      const res = await listAgents(query);
      expect(res.status).toBe(400);
      const envelope = await jsonBody<ErrorEnvelope>(res);
      expect(envelope.error.type).toBe("invalid_request_error");
    }
  });

  it("篡改游标内容或跨端点混用游标返回 400", async () => {
    const first = await jsonBody<PageJson<AgentJson>>(await listAgents("?limit=5"));
    const cursor = first.next_page;
    if (!cursor) throw new Error("expected next_page");

    // 内容被篡改(截断)
    const tampered = cursor.slice(0, cursor.length - 2);
    const res1 = await listAgents(`?page=${tampered}`);
    expect(res1.status).toBe(400);

    // 纯垃圾串
    const res2 = await listAgents("?page=not-a-cursor");
    expect(res2.status).toBe(400);

    // 其他列表端点的游标(kind 不匹配)——用 versions 的 kind 伪造
    const fake = btoa(JSON.stringify({ kind: "agent-versions", version: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res3 = await listAgents(`?page=${fake}`);
    expect(res3.status).toBe(400);
  });
});

describe("GET /v1/agents 归档与认证", () => {
  it("已归档的 Agent 仍出现在列表中", async () => {
    const archived = await createDefaultAgent({ name: "to-archive", model: "glm-5.3" });
    await archiveAgentInDb(archived.id);
    const page = await jsonBody<PageJson<AgentJson>>(await listAgents("?limit=100"));
    const found = page.data.find((item) => item.id === archived.id);
    expect(found).toBeDefined();
    expect(found?.archived_at).not.toBeNull();
  });

  it("不带凭证返回 401", async () => {
    const res = await exports.default.fetch("http://example.com/v1/agents");
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe("authentication_error");
  });
});
