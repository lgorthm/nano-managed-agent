#!/usr/bin/env bash
#
# nano-managed-agent 一键幂等部署脚本
#
# 目标:第一次拉下本仓库的人,在装有 node(>= 20)与 pnpm 的机器上直接运行
#   bash scripts/deploy.sh
# 即可完成到 Cloudflare 的完整部署;脚本可重复执行,重跑不会破坏任何已存在的
# 资源或已设置的 secret(存在则跳过,除非通过环境变量显式给出新值)。
#
# 脚本按顺序自动完成:
#   1. 前置检查(node/pnpm/wrangler 登录,未登录时在交互终端自动发起登录)
#   2. pnpm install 安装依赖
#   3. 把 CLOUDFLARE_ACCOUNT_ID 写回 apps/api/wrangler.jsonc(从 wrangler
#      whoami 解析;Agent 循环经它构造 AI Gateway REST API 地址),并查找或
#      自动创建 AI Gateway 网关 nano(@cf 模型请求必带 cf-aig-gateway-id 头;
#      自动创建需 CLOUDFLARE_API_TOKEN 带 AI Gateway Edit 权限)
#   4. 创建/复用 D1 数据库 nano-api-db,并把 database_id 写回 apps/api/wrangler.jsonc
#   5. 创建/复用 R2 桶 nano-files
#   6. 部署 apps/api(Durable Objects 迁移与沙箱容器镜像随 deploy 一并完成)
#   7. 对远端 D1 应用全部迁移(wrangler 交互确认时输入 y)
#   8. 设置 api 的 secret:API_KEY(缺省自动生成 48 位十六进制并打印一次)、
#      CLOUDFLARE_API_TOKEN(环境变量传入或交互输入;需 Workers AI Read 权限)
#   9. 把 console 的 NANO_API_BASE 接到刚部署的 api 地址,重新生成类型,
#      构建并部署 apps/console
#  10. 设置 console 的 secret:GLM_API_KEY(console 的 GLM 平台代理用,与模型
#      调用无关)、NANO_API_KEY(缺省复用 API_KEY 的值)
#
# 可选环境变量(均为"提供则强制写入,未提供则缺失时补齐"):
#   CLOUDFLARE_API_TOKEN    模型服务凭据(Cloudflare API Token,建议权限:
#                          Account > Workers AI > Read + AI Gateway > Edit,
#                          后者用于自动创建网关;创建入口 My Profile →
#                          API Tokens)。Agent 循环的模型调用全部经
#                          api.cloudflare.com 的 AI Gateway REST API
#   AI_GATEWAY_ID          AI Gateway 的网关 ID;提供则直接采用,缺省由脚本
#                          经 API 查找或创建网关 nano(@cf 模型请求必带
#                          cf-aig-gateway-id 头),写回 apps/api/wrangler.jsonc
#   GLM_API_KEY            GLM(智谱开放平台)API Key,https://bigmodel.cn
#                          (仅 console 的 GLM 平台代理使用,与 api 的模型调用无关)
#   API_KEY                nano API 自身的 Bearer 鉴权 Key
#   NANO_API_KEY           console 连 nano API 用的 Key(须与 API_KEY 同值)
#   NANO_API_BASE          nano API 上游地址;缺省用 api 部署输出的 workers.dev 地址
#   CF_ACCESS_TEAM_DOMAIN  Cloudflare Access 团队域名(https://<team>.cloudflareaccess.com)
#   CF_ACCESS_AUD          Cloudflare Access 应用的 Audience (AUD) Tag
#
# 脚本无法代替的两件事:
#   * Cloudflare Containers(会话沙箱)目前需要 Workers 付费计划,免费计划会在
#     api 部署一步失败;
#   * console 的 Cloudflare Access 应用需要在 Zero Trust 控制台手动创建(步骤见
#     docs/console.md「上线步骤」第 2 节)。换账号首次部署时,请通过上面两个
#     CF_ACCESS_* 环境变量传入本账号的值,否则登录后的所有请求都会 401。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
CONSOLE_DIR="$ROOT/apps/console"
API_DB_NAME="nano-api-db"
FILES_BUCKET="nano-files"

# UUID 形如 8-4-4-4-12 位十六进制,D1 的 database_id 即此形态
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# 中立工作目录:wrangler 按「当前目录向上」查找配置,在仓库内执行 d1 info
# 会被 apps/api/wrangler.jsonc 里的占位 database_id 劫持,导致把「id 未填」
# 误判成「数据库不存在」。中立目录下按名字查,行为才是纯粹的账号级查询。
NEUTRAL="$(mktemp -d)"
DEPLOY_LOG="$(mktemp)"
cleanup() { rm -rf "$NEUTRAL" "$DEPLOY_LOG"; }
trap cleanup EXIT

WRANGLER_BIN="${WRANGLER_BIN:-}"

# ---------------------------------------------------------------- 前置检查

say "检查 node / pnpm"
command -v node >/dev/null 2>&1 || die "未找到 node,请先安装 node >= 20(https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node 版本过低(当前 $(node -v)),本项目要求 >= 20"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm,请先执行:npm install -g pnpm@12.3.4 或 corepack enable"
ok "node $(node -v) / pnpm $(pnpm -v)"

say "安装依赖(pnpm install)"
pnpm install
[ -n "$WRANGLER_BIN" ] || WRANGLER_BIN="$API_DIR/node_modules/.bin/wrangler"
[ -x "$WRANGLER_BIN" ] || die "wrangler 不可用($WRANGLER_BIN),请确认 pnpm install 成功后重试"
w() { "$WRANGLER_BIN" "$@"; }

if w whoami >/dev/null 2>&1; then
  ok "wrangler 已登录 Cloudflare"
elif [ -t 0 ] && [ -t 1 ]; then
  say "尚未登录 Cloudflare,启动浏览器完成授权……"
  w login
  w whoami >/dev/null 2>&1 || die "wrangler 登录失败,请手动执行 $WRANGLER_BIN login 后重跑本脚本"
  ok "wrangler 登录成功"
else
  die "wrangler 未登录,且当前不是交互终端;请先执行: $WRANGLER_BIN login"
fi

# ---------------------------------------------------------------- 账号 ID 与网关 ID 写回

# Agent 循环的模型服务是 api.cloudflare.com 的 AI Gateway REST API,
# CLOUDFLARE_ACCOUNT_ID 从 whoami 解析后写回 apps/api/wrangler.jsonc
# (非敏感配置)。AI_GATEWAY_ID 的解析优先级:环境变量 > wrangler.jsonc 已有值
# > 经 CLOUDFLARE_API_TOKEN 自动创建(网关名固定 nano,需 token 带 AI Gateway
# Edit 权限) > 提示手动。cf_token 在此提前取值,后续 secret 写入直接复用。
api_config="$API_DIR/wrangler.jsonc"

account_id="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$account_id" ]; then
  account_id="$(w whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -n1 || true)"
fi
if [ -n "$account_id" ]; then
  say "把 CLOUDFLARE_ACCOUNT_ID 写回 apps/api/wrangler.jsonc"
  cur_account="$(sed -n -E 's/.*"CLOUDFLARE_ACCOUNT_ID"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config")"
  if [ "$cur_account" = "$account_id" ]; then
    ok "CLOUDFLARE_ACCOUNT_ID 已是最新值,无需修改"
  else
    sed -i -E "s/(\"CLOUDFLARE_ACCOUNT_ID\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$account_id\2/" "$api_config"
    grep -q "\"$account_id\"" "$api_config" || die "CLOUDFLARE_ACCOUNT_ID 写入失败,请手动检查 $api_config"
    ok "CLOUDFLARE_ACCOUNT_ID 已更新(原值:${cur_account:-<空>})"
  fi
else
  warn "未能解析账号 ID;请手动把 CLOUDFLARE_ACCOUNT_ID 填入 apps/api/wrangler.jsonc"
fi

write_gateway_id() { # <gateway_id>
  sed -i -E "s/(\"AI_GATEWAY_ID\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$1\2/" "$api_config"
  grep -q "\"$1\"" "$api_config" || die "AI_GATEWAY_ID 写入失败,请手动检查 $api_config"
  ok "AI_GATEWAY_ID 已更新:$1"
}

# 经 Cloudflare API 查找或创建网关 nano;成功输出网关 id,失败退出非零。
# 只用 node(脚本的硬性前置),不引入 curl/jq 依赖。
resolve_gateway() { # <token> <account_id>
  node -e '
    const [token, account] = process.argv.slice(1);
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways`;
    const auth = { Authorization: `Bearer ${token}` };
    const pick = (payload) =>
      Array.isArray(payload?.result)
        ? payload.result.find((g) => g && (g.id === "nano" || g.name === "nano"))
        : undefined;
    (async () => {
      const listed = await fetch(`${base}?per_page=100`, { headers: auth }).then((r) => r.json()).catch(() => null);
      const found = pick(listed);
      if (found?.id) { process.stdout.write(found.id); return; }
      const created = await fetch(base, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id: "nano" }),
      }).then((r) => r.json()).catch(() => null);
      if (created?.success && created.result?.id) { process.stdout.write(created.result.id); return; }
      // 创建失败可能是已存在(409 竞态)或权限不足(403):再列一次兜底前者
      const relisted = await fetch(`${base}?per_page=100`, { headers: auth }).then((r) => r.json()).catch(() => null);
      const again = pick(relisted);
      if (again?.id) { process.stdout.write(again.id); return; }
      process.exit(1);
    })();
  ' "$1" "$2"
}

cf_token="${CLOUDFLARE_API_TOKEN:-}"
cf_token_prompted=0
gateway_id="${AI_GATEWAY_ID:-}"
if [ -z "$gateway_id" ]; then
  cur_gateway="$(sed -n -E 's/.*"AI_GATEWAY_ID"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config")"
  if [ -n "$cur_gateway" ] && [ "$cur_gateway" != "填入网关 ID" ]; then
    ok "AI_GATEWAY_ID 已配置($cur_gateway),保持不变"
    gateway_id="$cur_gateway"
  fi
fi
if [ -z "$gateway_id" ] && [ -n "$account_id" ]; then
  # 网关未配置:优先用环境变量给出的 token;缺失时在交互终端提示一次
  # (取到的值同时供后续 secret 写入复用,不会重复询问)
  if [ -z "$cf_token" ] && [ -t 0 ]; then
    read -rs -p "输入 CLOUDFLARE_API_TOKEN(需 Workers AI Read;建议同时勾选 AI Gateway Edit 以自动创建网关;直接回车跳过): " cf_token || cf_token=""
    printf '\n'
    cf_token_prompted=1
  fi
  if [ -n "$cf_token" ]; then
    say "查找或创建 AI Gateway 网关 nano……"
    if gateway_id="$(resolve_gateway "$cf_token" "$account_id")" && [ -n "$gateway_id" ]; then
      write_gateway_id "$gateway_id"
      ok "网关 nano 已就绪(id=$gateway_id);@cf 模型请求将进入该网关的日志看板"
    else
      warn "自动创建网关失败(token 可能缺少 AI Gateway Edit 权限);请到控制台 AI → AI Gateway 创建网关后,经 AI_GATEWAY_ID 环境变量重跑本脚本,或手填 apps/api/wrangler.jsonc"
    fi
  fi
elif [ -n "$gateway_id" ] && [ -n "${AI_GATEWAY_ID:-}" ]; then
  say "把 AI_GATEWAY_ID 写回 apps/api/wrangler.jsonc"
  write_gateway_id "$gateway_id"
fi
if [ -z "$gateway_id" ]; then
  warn "AI_GATEWAY_ID 未配置:@cf 模型请求没有它会被拒绝;补齐方式见上一条提示"
fi

# ---------------------------------------------------------------- D1 数据库

db_id=""
if info_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" d1 info "$API_DB_NAME" 2>/dev/null)"; then
  db_id="$(printf '%s\n' "$info_out" | grep -oE "$UUID_RE" | head -n1 || true)"
fi
if [ -n "$db_id" ]; then
  ok "D1 数据库 $API_DB_NAME 已存在(uuid=$db_id),直接复用"
else
  say "创建 D1 数据库 $API_DB_NAME……"
  create_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" d1 create "$API_DB_NAME" 2>&1)" || {
    printf '%s\n' "$create_out" >&2
    die "d1 create 失败"
  }
  db_id="$(printf '%s\n' "$create_out" | grep -oE "$UUID_RE" | head -n1 || true)"
  if [ -z "$db_id" ]; then
    printf '%s\n' "$create_out" >&2
    die "无法从 d1 create 的输出中解析 database_id"
  fi
  ok "D1 数据库已创建(uuid=$db_id)"
fi

say "把 database_id 写回 apps/api/wrangler.jsonc"
cur_id="$(sed -n -E 's/.*"database_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config")"
if [ "$cur_id" = "$db_id" ]; then
  ok "database_id 已是最新值,无需修改"
else
  sed -i -E "s/(\"database_id\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$db_id\2/" "$api_config"
  grep -q "\"$db_id\"" "$api_config" || die "database_id 写入失败,请手动检查 $api_config"
  ok "database_id 已更新(原值:${cur_id:-<空>})"
fi

# ---------------------------------------------------------------- R2 桶

r2_has_bucket() {
  local list_out
  list_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" r2 bucket list 2>/dev/null || true)"
  printf '%s\n' "$list_out" | grep -qE "^name:[[:space:]]*${FILES_BUCKET}\$"
}

if r2_has_bucket; then
  ok "R2 桶 $FILES_BUCKET 已存在,直接复用"
else
  say "创建 R2 桶 $FILES_BUCKET……"
  if ! (cd "$NEUTRAL" && "$WRANGLER_BIN" r2 bucket create "$FILES_BUCKET"); then
    r2_has_bucket || die "R2 桶创建失败;若账号从未开通 R2,请先到 Cloudflare Dashboard 激活 R2(含免费额度)后重跑"
  fi
  ok "R2 桶已创建"
fi

# ---------------------------------------------------------------- 部署 apps/api

say "部署 apps/api(wrangler deploy,含 DO 迁移与沙箱容器镜像)"
if ! (cd "$API_DIR" && "$WRANGLER_BIN" deploy 2>&1 | tee "$DEPLOY_LOG"); then
  if grep -qiE 'containers?|subscription|paid plan|cloudchamber' "$DEPLOY_LOG"; then
    warn "部署输出提到 containers/subscription:会话沙箱使用的 Cloudflare Containers 目前需要 Workers 付费计划(每月 \$5),免费计划无法部署 apps/api"
  fi
  die "apps/api 部署失败,完整输出见上方"
fi
api_url="$(grep -oE 'https://nano-api[a-zA-Z0-9.-]*\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
if [ -n "$api_url" ]; then
  ok "apps/api 已部署:$api_url"
else
  warn "未能从部署输出解析出 workers.dev 地址(可能被关闭);后续 console 接线需要通过 NANO_API_BASE 环境变量手动指定"
fi

say "对远端 D1 应用迁移(出现确认提示时输入 y)"
(cd "$API_DIR" && "$WRANGLER_BIN" d1 migrations apply DB --remote) || die "D1 远端迁移失败"

# ---------------------------------------------------------------- secret 工具

# secret 只能挂在已部署的 Worker 上;Worker 尚不存在时 secret list 报错,
# 按「未设置」处理即可,后续 put_secret 会在部署之后执行。
secret_exists() { # <app_dir> <name>
  local list_out
  list_out="$(cd "$1" && "$WRANGLER_BIN" secret list 2>/dev/null || true)"
  printf '%s\n' "$list_out" | grep -qE "\"name\":[[:space:]]*\"$2\""
}

put_secret() { # <app_dir> <name> <value>
  printf '%s' "$3" | (cd "$1" && "$WRANGLER_BIN" secret put "$2" >/dev/null) || die "写入 secret $2 失败(目录 $1)"
}

# ---------------------------------------------------------------- api 的 API_KEY

generated_api_key=""
nano_key_value=""
if [ -n "${API_KEY:-}" ]; then
  put_secret "$API_DIR" API_KEY "$API_KEY"
  nano_key_value="$API_KEY"
  ok "API_KEY 已按环境变量写入 apps/api"
elif secret_exists "$API_DIR" API_KEY; then
  ok "apps/api 的 API_KEY 已存在,保持不变(值不可读回,console 侧如需同步请用 NANO_API_KEY 环境变量传入)"
else
  generated_api_key="$(node -p 'require("crypto").randomBytes(24).toString("hex")')"
  put_secret "$API_DIR" API_KEY "$generated_api_key"
  nano_key_value="$generated_api_key"
  printf '\n'
  printf '\033[1;33m════════════════════════════════════════════════════════════════\033[0m\n'
  printf '\033[1;33m  已自动生成 nano API 的鉴权 Key(仅此一次展示,请立即保存):\033[0m\n'
  printf '\033[1;33m  API_KEY = %s\033[0m\n' "$generated_api_key"
  printf '\033[1;33m  之后无法从 Cloudflare 读回;丢失只能删除 secret 重跑脚本换新值。\033[0m\n'
  printf '\033[1;33m════════════════════════════════════════════════════════════════\033[0m\n'
  printf '\n'
fi

# ---------------------------------------------------------------- console 配置

console_config="$CONSOLE_DIR/wrangler.jsonc"
nano_base="${NANO_API_BASE:-$api_url}"
if [ -n "$nano_base" ]; then
  say "配置 console 的 NANO_API_BASE = $nano_base"
  if grep -q '"NANO_API_BASE"' "$console_config"; then
    sed -i -E "s#(\"NANO_API_BASE\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1$nano_base\"#" "$console_config"
  else
    sed -i "/^[[:space:]]*\"vars\"[[:space:]]*:[[:space:]]*{/a\\    \"NANO_API_BASE\": \"$nano_base\"," "$console_config"
  fi
  grep -q "\"$nano_base\"" "$console_config" || die "NANO_API_BASE 写入失败,请手动检查 $console_config"
  ok "NANO_API_BASE 已写入 apps/console/wrangler.jsonc"
else
  warn "跳过 NANO_API_BASE 接线(无 api 地址可用);console 的 nano 后端将不可用"
fi

if [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ] || [ -n "${CF_ACCESS_AUD:-}" ]; then
  say "按环境变量更新 Cloudflare Access 配置"
  case "${CF_ACCESS_TEAM_DOMAIN:-}" in
    "") : ;;
    https://*|http://*) : ;;
    *) die "CF_ACCESS_TEAM_DOMAIN 需形如 https://<team>.cloudflareaccess.com" ;;
  esac
  if [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ]; then
    sed -i -E "s#(\"CF_ACCESS_TEAM_DOMAIN\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1${CF_ACCESS_TEAM_DOMAIN}\"#" "$console_config"
    ok "CF_ACCESS_TEAM_DOMAIN 已更新"
  fi
  if [ -n "${CF_ACCESS_AUD:-}" ]; then
    sed -i -E "s#(\"CF_ACCESS_AUD\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1${CF_ACCESS_AUD}\"#" "$console_config"
    ok "CF_ACCESS_AUD 已更新"
  fi
fi

say "重新生成 worker 类型(pnpm types)"
(cd "$ROOT" && pnpm types) || warn "pnpm types 失败,不影响本次部署,可稍后排查"

# ---------------------------------------------------------------- 部署 console

say "构建并部署 apps/console(vite build + wrangler deploy)"
# 注意必须用 pnpm run deploy:裸的 pnpm deploy 是 pnpm 的内置命令
# (workspace 打包部署),会遮蔽 package.json 里同名的 deploy 脚本,
# 报 ERR_PNPM_CANNOT_DEPLOY_MANY
if ! (cd "$CONSOLE_DIR" && pnpm run deploy 2>&1 | tee "$DEPLOY_LOG"); then
  die "apps/console 部署失败,完整输出见上方"
fi
console_url="$(grep -oE 'https://nano-console[a-zA-Z0-9.-]*\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
if [ -n "$console_url" ]; then
  ok "apps/console 已部署:$console_url"
else
  warn "未能从部署输出解析 console 的 workers.dev 地址,请到 Cloudflare Dashboard 确认"
fi

# ---------------------------------------------------------------- 模型服务凭据(api)与 GLM 代理凭据(console)

# api 的模型调用全部经 Cloudflare AI Gateway REST API:凭据是具有
# Workers AI Read 权限的 Cloudflare API Token(与账号登录态无关的独立令牌)。
# cf_token 已在网关解析一步取值(环境变量或交互输入);此处仅在
# 「此前未询问过且 secret 缺失」时补一次提示,避免重复询问
if [ -z "$cf_token" ] && [ "$cf_token_prompted" -eq 0 ] && ! secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN && [ -t 0 ]; then
  read -rs -p "输入 CLOUDFLARE_API_TOKEN(需 Workers AI Read 权限;直接回车跳过): " cf_token || cf_token=""
  printf '\n'
fi
if [ -n "$cf_token" ]; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || ! secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN; then
    put_secret "$API_DIR" CLOUDFLARE_API_TOKEN "$cf_token"
    ok "apps/api 的 CLOUDFLARE_API_TOKEN 已设置"
  fi
elif secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN; then
  ok "apps/api 的 CLOUDFLARE_API_TOKEN 已存在,保持不变"
else
  warn "未提供 CLOUDFLARE_API_TOKEN:api 的 Agent 循环(模型调用)将不可用;之后可重跑本脚本补填"
fi

# GLM_API_KEY 只属于 console:浏览器 → console Worker → agent-api.bigmodel.cn
# 的 GLM 平台代理(管理 agent/会话/文件等资源),与 api 的模型调用无关
glm="${GLM_API_KEY:-}"
if [ -z "$glm" ]; then
  if ! secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
    if [ -t 0 ]; then
      read -rs -p "输入 GLM_API_KEY(console 的 GLM 平台代理用,https://bigmodel.cn 获取;直接回车跳过): " glm || glm=""
      printf '\n'
    fi
  fi
fi
if [ -n "$glm" ]; then
  if [ -n "${GLM_API_KEY:-}" ] || ! secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
    put_secret "$CONSOLE_DIR" GLM_API_KEY "$glm"
    ok "apps/console 的 GLM_API_KEY 已设置"
  fi
elif secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
  ok "apps/console 的 GLM_API_KEY 已存在,保持不变"
else
  warn "未提供 GLM_API_KEY:console 的 GLM 平台代理将不可用;之后可重跑本脚本补填"
fi

# ---------------------------------------------------------------- console 的 NANO_API_KEY

if [ -n "${NANO_API_KEY:-}" ]; then
  put_secret "$CONSOLE_DIR" NANO_API_KEY "$NANO_API_KEY"
  ok "apps/console 的 NANO_API_KEY 已按环境变量写入"
elif secret_exists "$CONSOLE_DIR" NANO_API_KEY; then
  ok "apps/console 的 NANO_API_KEY 已存在,保持不变"
elif [ -n "$nano_key_value" ]; then
  put_secret "$CONSOLE_DIR" NANO_API_KEY "$nano_key_value"
  ok "apps/console 的 NANO_API_KEY 已同步为本次设置的 API_KEY"
elif [ -t 0 ]; then
  nano_key=""
  read -rs -p "输入 NANO_API_KEY(须与 nano API 侧的 API_KEY 同值;直接回车跳过): " nano_key || nano_key=""
  printf '\n'
  if [ -n "$nano_key" ]; then
    put_secret "$CONSOLE_DIR" NANO_API_KEY "$nano_key"
    ok "apps/console 的 NANO_API_KEY 已设置"
  else
    warn "已跳过 NANO_API_KEY:console 的 nano 后端请求会全部 401,之后可重跑本脚本补填"
  fi
else
  warn "非交互环境且无可用值,跳过 NANO_API_KEY;console 的 nano 后端请求会全部 401"
fi

# ---------------------------------------------------------------- 汇总

printf '\n'
say "部署完成,汇总:"
[ -n "$api_url" ]      && echo "  · nano API  : $api_url"
[ -n "$console_url" ]  && echo "  · 管理台    : $console_url"
echo  "  · api 鉴权  : 请求头 Authorization: Bearer <API_KEY>"
if [ -n "$generated_api_key" ]; then
  printf '  · 本次生成的 API_KEY = \033[1;33m%s\033[0m(仅此一次展示,请保存)\n' "$generated_api_key"
fi
if [ -n "$nano_base" ]; then
  echo "  · console 的 nano 后端上游:$nano_base"
fi
if ! grep -qE '"AI_GATEWAY_ID"[[:space:]]*:[[:space:]]*"填入网关 ID"' "$api_config"; then
  echo "  · 模型服务:api.cloudflare.com 的 AI Gateway REST API(网关 $(sed -n -E 's/.*"AI_GATEWAY_ID"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config"))"
else
  echo "  · 模型服务:AI_GATEWAY_ID 仍是占位值,Agent 循环尚不可用(见上方警告)"
fi
echo  "  · apps/*/wrangler.jsonc 的 database_id / CLOUDFLARE_ACCOUNT_ID / AI_GATEWAY_ID / NANO_API_BASE 改动建议提交进仓库"
echo  "  · 若这是新账号首次部署:console 登录依赖的 Cloudflare Access 应用仍需在"
echo  "    Zero Trust 控制台手动创建,并用 CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD 环境变量"
echo  "    重跑本脚本写入,步骤见 docs/console.md「上线步骤」第 2 节"
printf '\n'
ok "脚本幂等,重复执行安全:已存在的资源与 secret 不会被覆盖"
