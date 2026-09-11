import { describe, expect, it } from "vitest";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_PATH_LENGTH,
  MAX_PATH_SEGMENTS,
  MAX_SEGMENT_LENGTH,
  MAX_TOTAL_BYTES,
  normalizeSkillTree,
  type RawSkillFile,
} from "../../src";

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo skill.\n---\n\n# Demo\n";

/** 最小合法上传 */
function validFiles(): RawSkillFile[] {
  return [
    { path: "SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
    { path: "scripts/run.py", bytes: new TextEncoder().encode("print('hi')\n") },
  ];
}

async function normalize(files: RawSkillFile[]) {
  return normalizeSkillTree(files);
}

describe("normalizeSkillTree 路径校验", () => {
  it.each([
    ["/abs/SKILL.md", "absolute"],
    ["a/../SKILL.md", "dot-dot"],
    ["a\\SKILL.md", "backslash"],
    ["a/\0x", "nul"],
    [".git/config", "git"],
    [".git", "git-self"],
    ["a//b", "empty-segment"],
    ["a/./b", "dot-segment"],
    [`${"x".repeat(MAX_SEGMENT_LENGTH + 1)}/SKILL.md`, "segment-too-long"],
    [`${"a/".repeat(MAX_PATH_SEGMENTS)}SKILL.md`, "segments-too-many"],
    [`${"x".repeat(MAX_PATH_LENGTH)}${"y".repeat(50)}/SKILL.md`, "path-too-long"],
  ])("非法路径 %s (%s) 被拒绝", async (path) => {
    const result = await normalize([{ path, bytes: new TextEncoder().encode("x") }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_path");
  });

  it("空上传报 missing_skill_md", async () => {
    const result = await normalize([]);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_skill_md" } });
  });

  it("重复路径被拒绝", async () => {
    const files = validFiles().concat([{ path: "SKILL.md", bytes: new Uint8Array([1]) }]);
    const result = await normalize(files);
    expect(result).toMatchObject({ ok: false, error: { code: "duplicate_path", param: "SKILL.md" } });
  });
});

describe("normalizeSkillTree 单根剥离", () => {
  it("带单根前缀时剥离并记录 strippedRoot", async () => {
    const result = await normalize([
      { path: "pdf-tools/SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
      { path: "pdf-tools/scripts/run.py", bytes: new TextEncoder().encode("x") },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree.strippedRoot).toBe("pdf-tools");
      expect(result.tree.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
    }
  });

  it("无前缀时 strippedRoot 为 null", async () => {
    const result = await normalize(validFiles());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tree.strippedRoot).toBeNull();
  });

  it("前缀下没有 SKILL.md 报 missing_skill_md", async () => {
    const result = await normalize([
      { path: "tools/sub/SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_skill_md" } });
  });

  it("多个顶层目录无法定根,报 multi_root", async () => {
    const result = await normalize([
      { path: "a/SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
      { path: "b/x.py", bytes: new TextEncoder().encode("x") },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "multi_root" } });
  });

  it("SKILL.md 在顶层时即使存在子目录也不剥离", async () => {
    const result = await normalize(validFiles());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tree.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("SKILL.md 精确匹配大写,skill.md 不被接受", async () => {
    const result = await normalize([
      { path: "skill.md", bytes: new TextEncoder().encode(SKILL_MD) },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_skill_md" } });
  });
});

describe("normalizeSkillTree 上限裁决", () => {
  it("文件数恰好等于上限时通过,超出报 too_many_files", async () => {
    const atLimit = [
      { path: "SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
      ...Array.from({ length: MAX_FILES - 1 }, (_, i) => ({
        path: `f${i}.txt`,
        bytes: new TextEncoder().encode("x"),
      })),
    ];
    expect((await normalize(atLimit)).ok).toBe(true);
    expect((await normalize([...atLimit, { path: "extra.txt", bytes: new Uint8Array([1]) }]))).toMatchObject(
      { ok: false, error: { code: "too_many_files" } },
    );
  });

  it("单文件恰好 1 MiB 通过,超出报 file_too_large", async () => {
    const atLimit = [
      { path: "SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
      { path: "big.bin", bytes: new Uint8Array(MAX_FILE_BYTES) },
    ];
    expect((await normalize(atLimit)).ok).toBe(true);
    expect(
      (await normalize([{ path: "SKILL.md", bytes: new Uint8Array(MAX_FILE_BYTES + 1) }])),
    ).toMatchObject({ ok: false, error: { code: "file_too_large", param: "SKILL.md" } });
  });

  it("总量超出 20 MiB 报 total_too_large", async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      path: i === 0 ? "SKILL.md" : `f${i}.bin`,
      bytes: new Uint8Array(MAX_FILE_BYTES),
    }));
    expect((await normalize(files))).toMatchObject({ ok: false, error: { code: "total_too_large" } });
  });
});

describe("normalizeSkillTree 哈希与排序", () => {
  it("files 按 path 字典序排列", async () => {
    const result = await normalize([
      { path: "SKILL.md", bytes: new TextEncoder().encode(SKILL_MD) },
      { path: "zz.txt", bytes: new Uint8Array([1]) },
      { path: "aaa/b.txt", bytes: new Uint8Array([2]) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree.files.map((f) => f.path)).toEqual(["SKILL.md", "aaa/b.txt", "zz.txt"]);
    }
  });

  it("输入顺序打乱不影响 contentSha256(哈希对排序确定)", async () => {
    const files = validFiles().concat([{ path: "refs/a.md", bytes: new TextEncoder().encode("a") }]);
    const first = await normalize([...files]);
    const second = await normalize([...files].reverse());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.tree.contentSha256).toBe(first.tree.contentSha256);
      expect(second.tree.totalBytes).toBe(first.tree.totalBytes);
    }
  });

  it("任一文件内容变化都会改变 contentSha256", async () => {
    const first = await normalize(validFiles());
    const mutated = validFiles();
    mutated[1]!.bytes = new TextEncoder().encode("print('changed')\n");
    const second = await normalize(mutated);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.tree.contentSha256).not.toBe(first.tree.contentSha256);
    }
  });

  it("逐文件 sha256 与 totalBytes 统计正确", async () => {
    const result = await normalize(validFiles());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree.fileCount).toBe(2);
      expect(result.tree.totalBytes).toBe(
        new TextEncoder().encode(SKILL_MD).length + new TextEncoder().encode("print('hi')\n").length,
      );
      for (const file of result.tree.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
