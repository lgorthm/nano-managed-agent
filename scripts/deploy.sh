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

say "Checking node / pnpm"
command -v node >/dev/null 2>&1 || die "node not found; install node >= 20 first (https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node version too old (current $(node -v)); this project requires >= 20"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found; run first: npm install -g pnpm@12.3.4 or corepack enable"
ok "node $(node -v) / pnpm $(pnpm -v)"

say "Installing dependencies (pnpm install)"
pnpm install
[ -n "$WRANGLER_BIN" ] || WRANGLER_BIN="$API_DIR/node_modules/.bin/wrangler"
[ -x "$WRANGLER_BIN" ] || die "wrangler unavailable ($WRANGLER_BIN); make sure pnpm install succeeded, then retry"
w() { "$WRANGLER_BIN" "$@"; }

if w whoami >/dev/null 2>&1; then
  ok "wrangler logged in to Cloudflare"
elif [ -t 0 ] && [ -t 1 ]; then
  say "Not logged in to Cloudflare; opening the browser to authorize..."
  w login
  w whoami >/dev/null 2>&1 || die "wrangler login failed; run $WRANGLER_BIN login manually, then re-run this script"
  ok "wrangler login succeeded"
else
  die "wrangler not logged in and no interactive terminal; run first: $WRANGLER_BIN login"
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
  say "Writing CLOUDFLARE_ACCOUNT_ID back to apps/api/wrangler.jsonc"
  cur_account="$(sed -n -E 's/.*"CLOUDFLARE_ACCOUNT_ID"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config")"
  if [ "$cur_account" = "$account_id" ]; then
    ok "CLOUDFLARE_ACCOUNT_ID already up to date, nothing to change"
  else
    sed -i -E "s/(\"CLOUDFLARE_ACCOUNT_ID\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$account_id\2/" "$api_config"
    grep -q "\"$account_id\"" "$api_config" || die "failed to write CLOUDFLARE_ACCOUNT_ID; check $api_config manually"
    ok "CLOUDFLARE_ACCOUNT_ID updated (was: ${cur_account:-<empty>})"
  fi
else
  warn "Could not resolve the account ID; set CLOUDFLARE_ACCOUNT_ID manually in apps/api/wrangler.jsonc"
fi

write_gateway_id() { # <gateway_id>
  sed -i -E "s/(\"AI_GATEWAY_ID\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$1\2/" "$api_config"
  grep -q "\"$1\"" "$api_config" || die "failed to write AI_GATEWAY_ID; check $api_config manually"
  ok "AI_GATEWAY_ID updated: $1"
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
  if [ -n "$cur_gateway" ]; then
    ok "AI_GATEWAY_ID already configured ($cur_gateway), keeping it"
    gateway_id="$cur_gateway"
  fi
fi
if [ -z "$gateway_id" ] && [ -n "$account_id" ]; then
  # 网关未配置:优先用环境变量给出的 token;缺失时在交互终端提示一次
  # (取到的值同时供后续 secret 写入复用,不会重复询问)
  if [ -z "$cf_token" ] && [ -t 0 ]; then
    read -rs -p "Enter CLOUDFLARE_API_TOKEN (needs Workers AI Read; also tick AI Gateway Edit to auto-create the gateway; press Enter to skip): " cf_token || cf_token=""
    printf '\n'
    cf_token_prompted=1
  fi
  if [ -n "$cf_token" ]; then
    say "Looking up or creating AI Gateway nano..."
    if gateway_id="$(resolve_gateway "$cf_token" "$account_id")" && [ -n "$gateway_id" ]; then
      write_gateway_id "$gateway_id"
      ok "Gateway nano ready (id=$gateway_id); @cf model requests will show up in its dashboard"
    else
      warn "Gateway auto-creation failed (token may lack AI Gateway Edit permission); create the gateway in the dashboard under AI → AI Gateway, then re-run this script with AI_GATEWAY_ID set, or edit apps/api/wrangler.jsonc manually"
    fi
  fi
elif [ -n "$gateway_id" ] && [ -n "${AI_GATEWAY_ID:-}" ]; then
  say "Writing AI_GATEWAY_ID back to apps/api/wrangler.jsonc"
  write_gateway_id "$gateway_id"
fi
if [ -z "$gateway_id" ]; then
  warn "AI_GATEWAY_ID not configured: @cf model requests are rejected without it; see the hint above for how to fix"
fi

# ---------------------------------------------------------------- D1 数据库

db_id=""
if info_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" d1 info "$API_DB_NAME" 2>/dev/null)"; then
  db_id="$(printf '%s\n' "$info_out" | grep -oE "$UUID_RE" | head -n1 || true)"
fi
if [ -n "$db_id" ]; then
  ok "D1 database $API_DB_NAME already exists (uuid=$db_id), reusing"
else
  say "Creating D1 database $API_DB_NAME..."
  create_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" d1 create "$API_DB_NAME" 2>&1)" || {
    printf '%s\n' "$create_out" >&2
    die "d1 create failed"
  }
  db_id="$(printf '%s\n' "$create_out" | grep -oE "$UUID_RE" | head -n1 || true)"
  if [ -z "$db_id" ]; then
    printf '%s\n' "$create_out" >&2
    die "could not parse database_id from d1 create output"
  fi
  ok "D1 database created (uuid=$db_id)"
fi

say "Writing database_id back to apps/api/wrangler.jsonc"
cur_id="$(sed -n -E 's/.*"database_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config")"
if [ "$cur_id" = "$db_id" ]; then
  ok "database_id already up to date, nothing to change"
else
  sed -i -E "s/(\"database_id\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$db_id\2/" "$api_config"
  grep -q "\"$db_id\"" "$api_config" || die "failed to write database_id; check $api_config manually"
  ok "database_id updated (was: ${cur_id:-<empty>})"
fi

# ---------------------------------------------------------------- R2 桶

r2_has_bucket() {
  local list_out
  list_out="$(cd "$NEUTRAL" && "$WRANGLER_BIN" r2 bucket list 2>/dev/null || true)"
  printf '%s\n' "$list_out" | grep -qE "^name:[[:space:]]*${FILES_BUCKET}\$"
}

if r2_has_bucket; then
  ok "R2 bucket $FILES_BUCKET already exists, reusing"
else
  say "Creating R2 bucket $FILES_BUCKET..."
  if ! (cd "$NEUTRAL" && "$WRANGLER_BIN" r2 bucket create "$FILES_BUCKET"); then
    r2_has_bucket || die "R2 bucket creation failed; if R2 was never enabled on this account, activate it in the Cloudflare Dashboard first (free tier available), then re-run"
  fi
  ok "R2 bucket created"
fi

# ---------------------------------------------------------------- 部署 apps/api

say "Deploying apps/api (wrangler deploy, incl. DO migrations and sandbox container image)"
if ! (cd "$API_DIR" && "$WRANGLER_BIN" deploy 2>&1 | tee "$DEPLOY_LOG"); then
  if grep -qiE 'containers?|subscription|paid plan|cloudchamber' "$DEPLOY_LOG"; then
    warn "Deploy output mentions containers/subscription: Cloudflare Containers used by session sandboxes currently requires the Workers paid plan (\$5/month); apps/api cannot be deployed on the free plan"
  fi
  die "apps/api deploy failed; full output above"
fi
api_url="$(grep -oE 'https://nano-api[a-zA-Z0-9.-]*\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
if [ -n "$api_url" ]; then
  ok "apps/api deployed: $api_url"
else
  warn "Could not parse a workers.dev URL from the deploy output (possibly disabled); wiring up the console later requires setting NANO_API_BASE manually"
fi

say "Applying D1 migrations to the remote database (answer y when prompted)"
(cd "$API_DIR" && "$WRANGLER_BIN" d1 migrations apply DB --remote) || die "D1 remote migration failed"

# ---------------------------------------------------------------- secret 工具

# secret 只能挂在已部署的 Worker 上;Worker 尚不存在时 secret list 报错,
# 按「未设置」处理即可,后续 put_secret 会在部署之后执行。
secret_exists() { # <app_dir> <name>
  local list_out
  list_out="$(cd "$1" && "$WRANGLER_BIN" secret list 2>/dev/null || true)"
  printf '%s\n' "$list_out" | grep -qE "\"name\":[[:space:]]*\"$2\""
}

put_secret() { # <app_dir> <name> <value>
  printf '%s' "$3" | (cd "$1" && "$WRANGLER_BIN" secret put "$2" >/dev/null) || die "failed to write secret $2 (dir $1)"
}

# ---------------------------------------------------------------- api 的 API_KEY

generated_api_key=""
nano_key_value=""
if [ -n "${API_KEY:-}" ]; then
  put_secret "$API_DIR" API_KEY "$API_KEY"
  nano_key_value="$API_KEY"
  ok "API_KEY written to apps/api from the environment variable"
elif secret_exists "$API_DIR" API_KEY; then
  ok "apps/api API_KEY already exists, keeping it (the value cannot be read back; pass NANO_API_KEY to sync the console side)"
else
  generated_api_key="$(node -p 'require("crypto").randomBytes(24).toString("hex")')"
  put_secret "$API_DIR" API_KEY "$generated_api_key"
  nano_key_value="$generated_api_key"
  printf '\n'
  printf '\033[1;33m════════════════════════════════════════════════════════════════\033[0m\n'
  printf '\033[1;33m  A nano API auth key was generated (shown once, save it now):\033[0m\n'
  printf '\033[1;33m  API_KEY = %s\033[0m\n' "$generated_api_key"
  printf '\033[1;33m  It cannot be read back from Cloudflare; if lost, delete the secret and re-run this script for a new one.\033[0m\n'
  printf '\033[1;33m════════════════════════════════════════════════════════════════\033[0m\n'
  printf '\n'
fi

# ---------------------------------------------------------------- console 配置

console_config="$CONSOLE_DIR/wrangler.jsonc"
nano_base="${NANO_API_BASE:-$api_url}"
if [ -n "$nano_base" ]; then
  say "Configuring the console's NANO_API_BASE = $nano_base"
  if grep -q '"NANO_API_BASE"' "$console_config"; then
    sed -i -E "s#(\"NANO_API_BASE\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1$nano_base\"#" "$console_config"
  else
    sed -i "/^[[:space:]]*\"vars\"[[:space:]]*:[[:space:]]*{/a\\    \"NANO_API_BASE\": \"$nano_base\"," "$console_config"
  fi
  grep -q "\"$nano_base\"" "$console_config" || die "failed to write NANO_API_BASE; check $console_config manually"
  ok "NANO_API_BASE written to apps/console/wrangler.jsonc"
else
  warn "Skipping NANO_API_BASE wiring (no api URL available); the console's nano backend will be unavailable"
fi

if [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ] || [ -n "${CF_ACCESS_AUD:-}" ]; then
  say "Updating the Cloudflare Access config from environment variables"
  case "${CF_ACCESS_TEAM_DOMAIN:-}" in
    "") : ;;
    https://*|http://*) : ;;
    *) die "CF_ACCESS_TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com" ;;
  esac
  if [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ]; then
    sed -i -E "s#(\"CF_ACCESS_TEAM_DOMAIN\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1${CF_ACCESS_TEAM_DOMAIN}\"#" "$console_config"
    ok "CF_ACCESS_TEAM_DOMAIN updated"
  fi
  if [ -n "${CF_ACCESS_AUD:-}" ]; then
    sed -i -E "s#(\"CF_ACCESS_AUD\"[[:space:]]*:[[:space:]]*\")[^\"]*\"#\1${CF_ACCESS_AUD}\"#" "$console_config"
    ok "CF_ACCESS_AUD updated"
  fi
fi

say "Regenerating worker types (pnpm types)"
(cd "$ROOT" && pnpm types) || warn "pnpm types failed; it does not affect this deployment, investigate later"

# ---------------------------------------------------------------- 部署 console

say "Building and deploying apps/console (vite build + wrangler deploy)"
# 注意必须用 pnpm run deploy:裸的 pnpm deploy 是 pnpm 的内置命令
# (workspace 打包部署),会遮蔽 package.json 里同名的 deploy 脚本,
# 报 ERR_PNPM_CANNOT_DEPLOY_MANY
if ! (cd "$CONSOLE_DIR" && pnpm run deploy 2>&1 | tee "$DEPLOY_LOG"); then
  die "apps/console deploy failed; full output above"
fi
console_url="$(grep -oE 'https://nano-console[a-zA-Z0-9.-]*\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
if [ -n "$console_url" ]; then
  ok "apps/console deployed: $console_url"
else
  warn "Could not parse the console's workers.dev URL from the deploy output; check the Cloudflare Dashboard"
fi

# ---------------------------------------------------------------- 模型服务凭据(api)与 GLM 代理凭据(console)

# api 的模型调用全部经 Cloudflare AI Gateway REST API:凭据是具有
# Workers AI Read 权限的 Cloudflare API Token(与账号登录态无关的独立令牌)。
# cf_token 已在网关解析一步取值(环境变量或交互输入);此处仅在
# 「此前未询问过且 secret 缺失」时补一次提示,避免重复询问
if [ -z "$cf_token" ] && [ "$cf_token_prompted" -eq 0 ] && ! secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN && [ -t 0 ]; then
  read -rs -p "Enter CLOUDFLARE_API_TOKEN (needs Workers AI Read permission; press Enter to skip): " cf_token || cf_token=""
  printf '\n'
fi
if [ -n "$cf_token" ]; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || ! secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN; then
    put_secret "$API_DIR" CLOUDFLARE_API_TOKEN "$cf_token"
    ok "apps/api CLOUDFLARE_API_TOKEN set"
  fi
elif secret_exists "$API_DIR" CLOUDFLARE_API_TOKEN; then
  ok "apps/api CLOUDFLARE_API_TOKEN already exists, keeping it"
else
  warn "CLOUDFLARE_API_TOKEN not provided: the api's agent loop (model calls) will be unavailable; re-run this script later to fill it in"
fi

# GLM_API_KEY 只属于 console:浏览器 → console Worker → agent-api.bigmodel.cn
# 的 GLM 平台代理(管理 agent/会话/文件等资源),与 api 的模型调用无关
glm="${GLM_API_KEY:-}"
if [ -z "$glm" ]; then
  if ! secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
    if [ -t 0 ]; then
      read -rs -p "Enter GLM_API_KEY (for the console's GLM platform proxy, get one at https://bigmodel.cn; press Enter to skip): " glm || glm=""
      printf '\n'
    fi
  fi
fi
if [ -n "$glm" ]; then
  if [ -n "${GLM_API_KEY:-}" ] || ! secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
    put_secret "$CONSOLE_DIR" GLM_API_KEY "$glm"
    ok "apps/console GLM_API_KEY set"
  fi
elif secret_exists "$CONSOLE_DIR" GLM_API_KEY; then
  ok "apps/console GLM_API_KEY already exists, keeping it"
else
  warn "GLM_API_KEY not provided: the console's GLM platform proxy will be unavailable; re-run this script later to fill it in"
fi

# ---------------------------------------------------------------- console 的 NANO_API_KEY

if [ -n "${NANO_API_KEY:-}" ]; then
  put_secret "$CONSOLE_DIR" NANO_API_KEY "$NANO_API_KEY"
  ok "apps/console NANO_API_KEY written from the environment variable"
elif secret_exists "$CONSOLE_DIR" NANO_API_KEY; then
  ok "apps/console NANO_API_KEY already exists, keeping it"
elif [ -n "$nano_key_value" ]; then
  put_secret "$CONSOLE_DIR" NANO_API_KEY "$nano_key_value"
  ok "apps/console NANO_API_KEY synced with the API_KEY set in this run"
elif [ -t 0 ]; then
  nano_key=""
  read -rs -p "Enter NANO_API_KEY (must equal the API_KEY on the nano API side; press Enter to skip): " nano_key || nano_key=""
  printf '\n'
  if [ -n "$nano_key" ]; then
    put_secret "$CONSOLE_DIR" NANO_API_KEY "$nano_key"
    ok "apps/console NANO_API_KEY set"
  else
    warn "NANO_API_KEY skipped: console requests to the nano backend will all get 401; re-run this script later to fill it in"
  fi
else
  warn "Non-interactive environment with no value available, skipping NANO_API_KEY; console requests to the nano backend will all get 401"
fi

# ---------------------------------------------------------------- 汇总

printf '\n'
say "Deploy complete, summary:"
[ -n "$api_url" ]      && echo "  · nano API : $api_url"
[ -n "$console_url" ]  && echo "  · console  : $console_url"
echo  "  · api auth : send header Authorization: Bearer <API_KEY>"
if [ -n "$generated_api_key" ]; then
  printf '  · API_KEY generated this run = \033[1;33m%s\033[0m (shown once, save it)\n' "$generated_api_key"
fi
if [ -n "$nano_base" ]; then
  echo "  · console's nano backend upstream: $nano_base"
fi
echo  "  · model service: Cloudflare AI Gateway REST API on api.cloudflare.com (gateway $(sed -n -E 's/.*"AI_GATEWAY_ID"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$api_config"))"
echo  "  · consider committing the database_id / CLOUDFLARE_ACCOUNT_ID / AI_GATEWAY_ID / NANO_API_BASE changes in apps/*/wrangler.jsonc to the repo"
echo  "  · on a first deploy with a new account: the Cloudflare Access application behind"
echo  "    console login still has to be created manually in the Zero Trust dashboard, then"
echo  "    re-run this script with CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD set; see docs/console.md"
printf '\n'
ok "This script is idempotent and safe to re-run: existing resources and secrets are not overwritten"
