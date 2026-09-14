# nano console 部署与 Cloudflare Access 配置

`apps/console` 是 Managed Agents 的管理后台:SPA(`src/web`)+ 极小的 worker 代理(`src/worker`),部署为同一个 Worker(静态资源 + `main` 脚本)。登录由 Cloudflare Access 完成,worker 只做两件事:校验 Access JWT、把浏览器请求转发到所选后端并注入对应的 API Key——`/glm/*` → `https://agent-api.bigmodel.cn/api/*`(GLM),`/nano/*` → `NANO_API_BASE` + `/v1/*`(自建 nano API,即本仓库 `apps/api`)。用哪个后端由 sidebar 底部的 Select 切换,见下文「双后端切换」。

## 本地开发

```bash
cd apps/console
cp .dev.vars.example .dev.vars   # 填入 GLM_API_KEY;ACCESS_DEV_BYPASS=1 跳过 Access 校验
pnpm dev                         # vite(5173),worker 由 @cloudflare/vite-plugin 在同一进程内运行
```

本地没有 Access 登录页,`.dev.vars` 里的 `ACCESS_DEV_BYPASS=1` 会让 worker 跳过 JWT 校验——**这个值只允许出现在 .dev.vars,永远不要配置到生产**(wrangler.jsonc vars 或 `wrangler secret put`)。

要用 nano 后端,先在仓库根目录跑 `pnpm dev:api` 把 apps/api 跑在 `:8787`;`.dev.vars` 里的 `NANO_API_BASE=http://127.0.0.1:8787` 与 `NANO_API_KEY`(与 `apps/api/.dev.vars` 的 `API_KEY` 一致)即可开箱可用。

## 双后端切换(GLM / nano)

sidebar 底部的 Select 决定所有 API 请求走哪个后端,选择存 localStorage(缺省 nano),刷新后保持。切换会整库清空 React Query 缓存,不会串数据。

- **GLM**:九个资源全部可用,协议头(`zai-version`/`zai-beta`)与分页均为 GLM 原生。
- **nano**:目前实现了 agents / environments / skills / files 四个资源;Sessions、Deployments、Memories、Vaults 的请求会得到 404,页面显示错误态属预期。浏览器侧始终发 GLM 形状的路径(`/agent/managed/v1/*`)与参数,协议差异全部由 worker 的 `/nano` 分支消化:路径改写为 `/v1/*`、鉴权换成 `NANO_API_KEY`、不带 zai 头;files 列表分页是唯一的 wire 差异点,GLM 的 `after_id`/`has_more`/`last_id` 与 nano 的 opaque `page` 游标/`next_page` 在代理层互转(`src/worker/proxy.ts` 的 `proxyToNano`)。

### nano 后端的传输(Service Binding)

nano-api 与 nano-console 部署在同一个 Cloudflare 账号下,而 Cloudflare **不允许同账号的 Worker 之间用普通 fetch 互访**——边缘会直接返回 404 与 "error code: 1042",请求根本到不了 nano-api。因此生产环境的 `/nano/*` 请求经 `wrangler.jsonc` 里的 Service Binding(`NANO_API_SERVICE` → `nano-api` Worker)直连:绑定的 fetch 忽略 URL 主机、按绑定路由,`NANO_API_BASE` 只用来构造路径与查询串(以及 Settings 页展示)。本地 `vite dev` 不建立该绑定,`proxyToNano` 在无绑定时回退普通 fetch,仍按 `.dev.vars` 的 `NANO_API_BASE` 连本地 `wrangler dev` 的 api;vitest 里由 `vitest.config.ts` 的 `miniflare.workers` 提供同名桩服务,保证 workerd 能启动。注意绑定要求 nano-api 先于 nano-console 存在,`pnpm deploy:init` 的部署顺序已保证。

## 上线步骤

### 1. 配置 GLM API Key(secret)

wrangler 是项目内依赖(非全局命令),统一用 `pnpm exec` 调用,在 `apps/console` 目录下执行:

```bash
cd apps/console
pnpm exec wrangler login             # 首次使用先登录 Cloudflare 账号
pnpm exec wrangler deploy            # secret 绑定要求 Worker 已存在,先部署一次
pnpm exec wrangler secret put GLM_API_KEY   # 粘贴 https://bigmodel.cn/usercenter/proj-mgmt/apikeys 的 Key
```

### 1b. 配置 nano 后端(可选)

要用 nano 后端:`wrangler.jsonc` 的 `vars` 里加 `NANO_API_BASE`(nano API Worker 的公网地址,如 `https://nano-api.<子域>.workers.dev`),再 `pnpm exec wrangler secret put NANO_API_KEY`(与 nano API 侧配置的 `API_KEY` 相同值)。改完 `wrangler.jsonc` 重跑 `pnpm types` 同步生成类型。

### 2. 配置 Cloudflare Access(登录)

1. Cloudflare Dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → Self-hosted。
2. Application domain 填 console 的域名(如 `nano-console.<你的子域>.workers.dev`,或接入的自定义域名)。
3. 配置 Policy:Action = Allow,Include 按需(如特定邮箱、邮箱后缀)。登录方式在 Zero Trust → Settings → Authentication methods 里配置(Cloudflare 账号、一次性验证码、GitHub 等)。
4. 在应用 **Configure → Additional settings** 里复制两样东西:
   - **Team Domain**:`https://<team>.cloudflareaccess.com`
   - **Application Audience (AUD) Tag**:`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.access`
5. 填进 `apps/console/wrangler.jsonc` 的 `vars`(非敏感,可提交),然后重跑 `pnpm types` 同步生成的类型。

### 3. 部署

```bash
cd apps/console
pnpm run deploy    # vite build && wrangler deploy(裸 pnpm deploy 是 pnpm 内置命令,须带 run)
```

部署完成后访问域名,未登录会被 Access 拦截;登录后 SPA 里所有 GLM 请求都走同域 `/glm/*`。

## 安全模型(两层防线)

| 层 | 机制 | 失效时 |
| --- | --- | --- |
| 第一层 | Cloudflare Access 挡在域名前 | 未登录者拿不到任何页面/JS |
| 第二层 | worker 校验 `Cf-Access-Jwt-Assertion`(jose + JWKS,issuer/audience 校验) | Access 策略误配(如 workers.dev 未关)时代理仍拒绝出网 |

GLM 与 nano 的 API Key 都只存在于 worker secret,永远不会到达浏览器;两个代理分支(`/glm/*`、`/nano/*`)受同一层 Access JWT 校验保护。

## 浏览器与移动端支持

| 浏览器 | 最低版本 | 依据 |
| --- | --- | --- |
| Chrome / Edge(Chromium) | 111 | Tailwind v4 基线 + oklch |
| Safari / iOS Safari | 16.4 | Tailwind v4 基线(`svh`、oklch、fetch 流式 SSE 均在其内) |
| Firefox | 128 | Tailwind v4 基线 |

只使用基线内的标准特性(无 `-webkit-` 私有前缀、无 polyfill),实时事件流用手写 fetch 流式解析(非原生 `EventSource`),三浏览器行为一致。

移动端(视口 < 768px)行为:桌面侧边栏替换为顶部栏 + 汉堡抽屉导航;列表页隐藏次要列(模型/版本/Tokens 等),整行可点进详情;表单控件移动端字号 16px,避免 iOS Safari 聚焦时自动缩放页面。桌面端(≥ 768px)布局保持不变。

## 常见问题

- **页面能打开但所有请求 401**:线上说明 Access JWT 校验失败——检查 `CF_ACCESS_TEAM_DOMAIN`(必须带 `https://` 且无尾斜杠)与 `CF_ACCESS_AUD` 是否为该应用自身的值。
- **请求 503 config_error**:`wrangler.jsonc` 里的 vars 还是 `TODO-` 占位,按上文第 2 步填写。
- **Settings 页显示「local dev」**:正常,本地 `vite dev` 没有 Access;线上出现才需要排查。
