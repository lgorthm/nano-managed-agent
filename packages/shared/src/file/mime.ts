/**
 * 沙箱产出文件的 media type 推断:产出没有上传侧的 Content-Type,
 * 只能从扩展名映射;未知扩展名回退 application/octet-stream
 * (与 normalizeMimeType 的缺省分支同一口径)。
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  // 文本与数据
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  jsonl: 'application/jsonl',
  ndjson: 'application/jsonl',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  // 源代码(取常见 text/* 与两类 application 脚本)
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/javascript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java-source',
  sh: 'application/x-sh',
  sql: 'application/sql',
  // 文档
  pdf: 'application/pdf',
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  // 音视频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  // 压缩与归档
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
};

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/**
 * 按 outputs 相对路径推断 media type:取 basename 最后一个 `.` 之后的
 * 小写扩展名查表;无扩展名、隐藏文件(.bashrc 形态)或未知扩展名回退
 * application/octet-stream。
 */
export function mimeTypeFromPath(path: string): string {
  const basename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return FALLBACK_MIME_TYPE;
  return MIME_BY_EXTENSION[basename.slice(dot + 1).toLowerCase()] ?? FALLBACK_MIME_TYPE;
}
