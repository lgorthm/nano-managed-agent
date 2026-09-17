#!/usr/bin/env bash
# 固化 docs/agent/structure.md 的三条依赖规则:
#   1. modules 之间禁止横向引用(资源复用走 @nano/shared 或提升到 lib/)
#   2. @nano/shared 零内部依赖(只允许依赖 zod)
#   3. @nano/db 不引用 @nano/api
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
status=0

check() {
  local label="$1" pattern="$2" target="$3"
  local hits
  hits="$(grep -rEn "$pattern" "$target" --include='*.ts' 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "✗ $label"
    echo "$hits"
    status=1
  else
    echo "✓ $label"
  fi
}

check "modules 之间无横向引用" '\.\./\.\./modules/' "$root/apps/api/src/modules"
# 引号模式同时匹配单引号与双引号:biome 统一格式化为单引号,历史代码可能仍是双引号
check "shared 零内部依赖(@nano/*)" "from [\"']@nano/" "$root/packages/shared/src"
check "db 不引用 @nano/api" "from [\"']@nano/api" "$root/packages/db/src"

exit $status
