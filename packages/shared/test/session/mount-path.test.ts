import { describe, expect, it } from 'vitest';
import {
  MAX_MOUNT_PATH_BYTES,
  mountPathsOverlap,
  normalizeMountPath,
  overlapsAnyMountPath,
  SESSION_UPLOAD_ROOT,
} from '../../src/session/mount-path';

const FILE_ID = 'file_01911111-5555-7555-8555-555555555555';

describe('normalizeMountPath 默认与拼接', () => {
  it('省略与 null 都得到默认路径', () => {
    const expected = `${SESSION_UPLOAD_ROOT}/${FILE_ID}`;
    expect(normalizeMountPath(undefined, FILE_ID)).toEqual({
      ok: true,
      path: expected,
    });
    expect(normalizeMountPath(null, FILE_ID)).toEqual({
      ok: true,
      path: expected,
    });
  });

  it('相对路径拼接到根之下', () => {
    expect(normalizeMountPath('datasets/q2.csv', FILE_ID)).toEqual({
      ok: true,
      path: `${SESSION_UPLOAD_ROOT}/datasets/q2.csv`,
    });
  });

  it('绝对路径也视为根内的路径(去掉开头 / 后拼接)', () => {
    expect(normalizeMountPath('/etc/passwd', FILE_ID)).toEqual({
      ok: true,
      path: `${SESSION_UPLOAD_ROOT}/etc/passwd`,
    });
  });

  it('多个连续斜杠与点段被消解', () => {
    expect(normalizeMountPath('a//b/./c', FILE_ID)).toEqual({
      ok: true,
      path: `${SESSION_UPLOAD_ROOT}/a/b/c`,
    });
    expect(normalizeMountPath('./a/.', FILE_ID)).toEqual({
      ok: true,
      path: `${SESSION_UPLOAD_ROOT}/a`,
    });
  });

  it('段内的 .. 弹出上一段', () => {
    expect(normalizeMountPath('a/b/../c', FILE_ID)).toEqual({
      ok: true,
      path: `${SESSION_UPLOAD_ROOT}/a/c`,
    });
  });
});

describe('normalizeMountPath 非法输入', () => {
  it('空串拒绝(与省略不同)', () => {
    expect(normalizeMountPath('', FILE_ID)).toMatchObject({ ok: false });
  });

  it('反斜杠拒绝', () => {
    expect(normalizeMountPath('a\\b', FILE_ID)).toMatchObject({ ok: false });
  });

  it('.. 越过根即逃逸,拒绝', () => {
    expect(normalizeMountPath('../escape', FILE_ID)).toMatchObject({
      ok: false,
    });
    expect(normalizeMountPath('/../../escape', FILE_ID)).toMatchObject({
      ok: false,
    });
    expect(normalizeMountPath('a/../../escape', FILE_ID)).toMatchObject({
      ok: false,
    });
  });

  it('解析到根自身拒绝(不能挂掉整个 uploads 目录)', () => {
    expect(normalizeMountPath('..', FILE_ID)).toMatchObject({ ok: false });
    expect(normalizeMountPath('/', FILE_ID)).toMatchObject({ ok: false });
    expect(normalizeMountPath('.', FILE_ID)).toMatchObject({ ok: false });
  });

  it('UTF-8 总长度超过 1024 字节拒绝', () => {
    // 每个汉字 3 字节;路径总长 = 根(21 字节) + 斜杠 + 段
    const segment = '汉'.repeat(340); // 1020 字节,加上根与斜杠超限
    const result = normalizeMountPath(segment, FILE_ID);
    expect(result.ok).toBe(false);
    // 边界内通过:总字节数恰好不超
    const fitting = 'a'.repeat(MAX_MOUNT_PATH_BYTES - SESSION_UPLOAD_ROOT.length - 1);
    expect(normalizeMountPath(fitting, FILE_ID)).toMatchObject({ ok: true });
  });
});

describe('mountPathsOverlap 重叠判定', () => {
  it('相等路径重叠', () => {
    expect(mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/a.csv`, `${SESSION_UPLOAD_ROOT}/a.csv`)).toBe(
      true,
    );
  });

  it('目录与其中文件互为前缀,重叠', () => {
    expect(
      mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/data`, `${SESSION_UPLOAD_ROOT}/data/a.csv`),
    ).toBe(true);
    expect(
      mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/data/a.csv`, `${SESSION_UPLOAD_ROOT}/data`),
    ).toBe(true);
  });

  it('兄弟路径不重叠', () => {
    expect(mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/data-a`, `${SESSION_UPLOAD_ROOT}/data`)).toBe(
      false,
    );
    expect(
      mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/data/a.csv`, `${SESSION_UPLOAD_ROOT}/data/b.csv`),
    ).toBe(false);
  });

  it('同文件名不同目录不重叠', () => {
    expect(
      mountPathsOverlap(`${SESSION_UPLOAD_ROOT}/x/a.csv`, `${SESSION_UPLOAD_ROOT}/y/a.csv`),
    ).toBe(false);
  });

  it('overlapsAnyMountPath 命中任意一条即真', () => {
    const existing = [`${SESSION_UPLOAD_ROOT}/data`, `${SESSION_UPLOAD_ROOT}/logs/app.log`];
    expect(overlapsAnyMountPath(`${SESSION_UPLOAD_ROOT}/data/new.csv`, existing)).toBe(true);
    expect(overlapsAnyMountPath(`${SESSION_UPLOAD_ROOT}/logs`, existing)).toBe(true);
    expect(overlapsAnyMountPath(`${SESSION_UPLOAD_ROOT}/other`, existing)).toBe(false);
    expect(overlapsAnyMountPath(`${SESSION_UPLOAD_ROOT}/data`, [])).toBe(false);
  });
});
