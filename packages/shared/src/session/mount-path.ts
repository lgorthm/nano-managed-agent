/**
 * 挂载路径的归一化与重叠判定(docs/session/schema.md 的 mount_path 规则):
 * - 省略 / null → 默认 /mnt/session/uploads/{file_id}
 * - 任意输入(相对或绝对)都拼接到 /mnt/session/uploads 之下,逐段消解 . 与 ..
 * - .. 越过根即"逃逸",结果为根自身同样非法(不能把根目录整体挂掉)
 * - 结果为 UTF-8 字节数 ≤ 1024 的 POSIX 绝对路径
 * 重叠 = 按路径段互为前缀(含相等);兄弟路径不算重叠。
 */
export const SESSION_UPLOAD_ROOT = "/mnt/session/uploads";
export const MAX_MOUNT_PATH_BYTES = 1024;

export type MountPathResult = { ok: true; path: string } | { ok: false; message: string };

function ok(path: string): MountPathResult {
  return { ok: true, path };
}

function fail(message: string): MountPathResult {
  return { ok: false, message };
}

/** 归一化挂载路径;fileId 用于省略 mount_path 时的默认路径 */
export function normalizeMountPath(input: string | null | undefined, fileId: string): MountPathResult {
  if (input === null || input === undefined) {
    return ok(`${SESSION_UPLOAD_ROOT}/${fileId}`);
  }
  if (input === "") {
    return fail("mount_path must not be empty; omit it or pass null for the default path");
  }
  if (input.includes("\\")) {
    return fail("mount_path must use / as the path separator");
  }

  const stripped = input.startsWith("/") ? input.slice(1) : input;
  const segments: string[] = [];
  for (const segment of stripped.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return fail("mount_path must not escape /mnt/session/uploads");
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    return fail("mount_path must not resolve to /mnt/session/uploads itself");
  }

  const path = `${SESSION_UPLOAD_ROOT}/${segments.join("/")}`;
  if (new TextEncoder().encode(path).length > MAX_MOUNT_PATH_BYTES) {
    return fail(`mount_path must be at most ${MAX_MOUNT_PATH_BYTES} UTF-8 bytes`);
  }
  return ok(path);
}

/** 两条归一化后的路径是否按路径段互为前缀(含相等) */
export function mountPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const segmentsA = a.split("/");
  const segmentsB = b.split("/");
  const shorter = Math.min(segmentsA.length, segmentsB.length);
  for (let i = 0; i < shorter; i++) {
    if (segmentsA[i] !== segmentsB[i]) return false;
  }
  return true;
}

/** candidate 是否与 existing 中任意一条重叠 */
export function overlapsAnyMountPath(candidate: string, existing: string[]): boolean {
  return existing.some((path) => mountPathsOverlap(candidate, path));
}
