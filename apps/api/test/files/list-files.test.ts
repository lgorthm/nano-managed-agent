import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDefaultFile,
  jsonBody,
  listFiles,
  type ErrorEnvelope,
  type FileJson,
  type PageJson,
} from "./helpers";

beforeAll(applyMigrations);

function isSorted(items: FileJson[], order: "asc" | "desc"): boolean {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!.created_at;
    const curr = items[i]!.created_at;
    if (order === "desc" ? prev < curr : prev > curr) return false;
  }
  return true;
}

describe("GET /v1/files 分页", () => {
  it("默认参数:每页 20、按上传时间倒序,游标翻到尾页", async () => {
    for (let i = 0; i < 25; i++) {
      await createDefaultFile(`item ${i}`);
    }
    const page1 = await jsonBody<PageJson<FileJson>>(await listFiles());
    expect(page1.data).toHaveLength(20);
    expect(page1.next_page).toBeTruthy();
    expect(isSorted(page1.data, "desc")).toBe(true);

    const page2 = await jsonBody<PageJson<FileJson>>(await listFiles(`?page=${page1.next_page}`));
    expect(page2.data).toHaveLength(5);
    expect(page2.next_page).toBeNull();
    const ids1 = new Set(page1.data.map((f) => f.id));
    for (const item of page2.data) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });

  it("limit=5 生效且两页无重叠", async () => {
    const page1 = await jsonBody<PageJson<FileJson>>(await listFiles("?limit=5"));
    expect(page1.data).toHaveLength(5);
    const page2 = await jsonBody<PageJson<FileJson>>(await listFiles(`?limit=5&page=${page1.next_page}`));
    const ids1 = new Set(page1.data.map((f) => f.id));
    for (const item of page2.data) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });

  it("order=asc 正序", async () => {
    const page = await jsonBody<PageJson<FileJson>>(await listFiles("?order=asc&limit=100"));
    expect(page.data.length).toBeGreaterThan(0);
    expect(isSorted(page.data, "asc")).toBe(true);
  });

  it("limit=200 被截断为 100", async () => {
    // 库中已有 30 个,再造 105 个确保超过 100;恰好返回 100 条证明截断生效
    for (let i = 0; i < 105; i++) {
      await createDefaultFile(`bulk ${i}`);
    }
    const page = await jsonBody<PageJson<FileJson>>(await listFiles("?limit=200"));
    expect(page.data).toHaveLength(100);
    expect(page.next_page).toBeTruthy();
  });
});

describe("GET /v1/files 参数校验", () => {
  it("limit=0、order 非法、游标篡改、其他端点游标混用分别返回 400", async () => {
    for (const query of ["?limit=0", "?limit=abc", "?order=bogus", "?page=not-a-cursor"]) {
      const res = await listFiles(query);
      expect(res.status).toBe(400);
      expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("invalid_request_error");
    }
    // kind 前缀不同的游标(agents)传给 files 端点 → 400,静默错页被挡下
    const alienCursor = btoa(JSON.stringify({ kind: "agents", createdAt: 1, id: "x" }));
    expect((await listFiles(`?page=${alienCursor}`)).status).toBe(400);
  });
});

describe("GET /v1/files scope_id 过滤", () => {
  it("sess_ 前缀恒返回空页(一期无 session-scoped 文件)", async () => {
    const page = await jsonBody<PageJson<FileJson>> (
      await listFiles("?scope_id=sess_01911111-3333-7444-8555-666666666666"),
    );
    expect(page.data).toEqual([]);
    expect(page.next_page).toBeNull();
  });

  it("非 sess_ 前缀返回 400", async () => {
    const res = await listFiles("?scope_id=agent_01911111");
    expect(res.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(res)).error.type).toBe("invalid_request_error");
  });

  it("缺少凭证返回 401", async () => {
    const res = await listFiles("", { Authorization: "" });
    expect(res.status).toBe(401);
  });
});
