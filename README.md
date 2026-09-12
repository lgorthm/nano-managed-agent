# nano-managed-agent

A minimal managed-agent runtime on Cloudflare — 复刻"云端托管 Agent 运行环境"的核心闭环:
API 定义 Agent → 启动有状态 Session → 平台驱动 Agent 循环 → 沙箱执行工具 → SSE 事件流交互。

## 架构(目标形态)

| Cloudflare 组件 | 角色 |
| --- | --- |
| Workers | API 网关(`/v1/agents`、`/v1/sessions` 等) |
| Durable Objects | 每个 Session 一个:事件历史 + SSE 推流(二期) |
| Workflows | 每轮 Agent 循环的持久执行(二期) |
| Sandbox SDK | 会话沙箱:bash / 文件工具(二期) |
| D1 | 元数据:agents / skills / files(内容在 R2)/ environments / sessions |
| R2 | File 资源内容存储(`FILES` 绑定,见 [docs/files/schema.md](docs/files/schema.md));会话产出文件(二期) |

整体架构图、API 请求链路与 D1 数据模型的 Mermaid 图见 [docs/architecture-diagrams.md](docs/architecture-diagrams.md)。

## 目录结构

```
apps/
  api/            # Cloudflare Worker(Hono):API 网关
  console/        # 管理后台:React SPA + worker 代理(shadcn/ui + Tailwind)
                  #   登录走 Cloudflare Access;GLM Key 存 worker secret,经 /glm/* 代理注入
packages/
  shared/         # API 类型与 zod schema(前后端共用);./glm 子导出为 GLM Managed Agents DTO
  db/             # Drizzle schema + D1 查询帮助函数
```

内部包不构建:`exports` 直接指向 TS 源码,wrangler/vite 打包时直接消费。

资源模块内部的代码目录结构与分层规则见 [docs/agent/structure.md](docs/agent/structure.md)(以 Agent 模块为样板),按接口推进的实现计划见 [docs/agent/work-plan.md](docs/agent/work-plan.md)。

Session 资源(一期元数据控制面,事件与运行时属二期)的设计文档见 [docs/session/](docs/session/):[schema.md](docs/session/schema.md)(表结构)、[structure.md](docs/session/structure.md)(模块结构)、[api/](docs/session/api/)(10 个端点)、[work-plan.md](docs/session/work-plan.md)(实现计划)。

管理后台的部署与 Cloudflare Access 配置见 [docs/console.md](docs/console.md)。

## 开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 同时启动 api(wrangler dev, :8787)与 console(vite, :5173)
pnpm dev:api        # 仅启动 api
pnpm dev:console    # 仅启动 console(首次需 cp apps/console/.dev.vars.example .dev.vars)
pnpm test           # 运行测试(真实 Workers 运行时,基于 @cloudflare/vitest-plugin)
pnpm typecheck      # 全仓类型检查
pnpm types          # 修改 wrangler.jsonc 后重新生成各 app 的 worker-configuration.d.ts
pnpm deploy         # 部署到 Cloudflare
```

D1(首次使用):

```bash
pnpm --filter @nano/api exec wrangler d1 create nano-api-db
# 把返回的 database_id 填入 apps/api/wrangler.jsonc
pnpm db:generate    # 由 packages/db 的 schema 生成迁移
pnpm db:migrate:local
```
