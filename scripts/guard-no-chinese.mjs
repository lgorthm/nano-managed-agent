/**
 * 服务端字符串字面量禁止中文的防回归守卫(NMA-33)。
 *
 * 背景:服务端 API 返回与错误日志统一英文(NMA-30/31/32 已清理存量),
 * 代码注释按仓库约定保留中文。守卫剥离注释后扫描代码,任何残留中文
 * 都只可能位于字符串字面量,命中即失败,防止后续提交把中文写回服务端。
 *
 * 判定方法(2026-09-15 审计验证):
 *   1. 剥块注释 /…/(非贪婪);
 *   2. 逐行剥行注释,仅当 // 位于行首或前导空白之后(保护字符串里的
 *      URL,如 https:// 的 :// 前是冒号不受影响);
 *   3. 剥离后出现 [\u4e00-\u9fa5] 即违规——多行模板字符串、插值内
 *      字符串、正则字面量均无盲区。
 *
 * 范围仅服务端三目录:apps/api/src、packages/shared/src、
 * apps/console/src/worker。apps/console/src/web 归 i18n 系列
 * (NMA-26~29)处理,测试与 mock 含中文属正常,均不在范围。
 *
 * 仅用 node 内置模块,经根 package.json 的 lint:lang 运行。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCOPES = ["apps/api/src", "packages/shared/src", "apps/console/src/worker"];
const CJK = /[\u4e00-\u9fa5]/;

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const files = SCOPES.flatMap((scope) => listTsFiles(join(ROOT, scope)));
const hits = [];
for (const file of files) {
  const stripped = stripComments(readFileSync(file, "utf8"));
  stripped.split("\n").forEach((line, i) => {
    if (CJK.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length > 0) {
  console.error("✗ 服务端代码的字符串字面量中发现中文(注释除外):");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(`✗ 共 ${hits.length} 处,见上(服务端输出须为英文,注释不受限)`);
  process.exit(1);
}
console.log(`✓ 服务端字符串字面量无中文(扫描 ${files.length} 个文件)`);
