# 架构图与流程图

本文用 Mermaid 描述 nano-managed-agent 的整体目标架构、nano-api 的请求链路,以及 D1 数据模型。
图中的绑定名(`DB`、`SESSION_DO`、`FILES`)、路由、表名均与仓库代码一一对应。

## 1. 总目标架构

系统分四个平面:

- **管理面**(nano-console):浏览器经 Cloudflare Access 登录后使用 React SPA;SPA 的所有 API 调用走同源 `/glm/*` 代理,由 Worker 校验 Access JWT、注入 `GLM_API_KEY` 后转发到 GLM Managed Agents API,密钥永不进浏览器,SSE 流式透传。
- **API 平面**(nano-api):Hono Worker,`/v1` 路由以 `API_KEY` Bearer 认证,管理 agents / skills / sessions 等元数据,落在 D1。
- **会话运行时**:每个 Session 一个 `SESSION_DO` Durable Object——状态机、事件历史、SSE 推流与 Agent 循环执行(turn 执行器自管两级检查点与崩溃恢复,不使用 Workflows,见 [session/runtime.md](session/runtime.md));工具在 Sandbox SDK 会话沙箱中运行;产出文件写 R2。
- **模型服务**:Agent 循环经 Cloudflare AI Gateway REST API(`/accounts/{id}/ai/v1/chat/completions`,OpenAI chat 格式)调用 Cloudflare 托管的 `@cf/zai-org/*` 模型;存量模型 id `glm-5.3` / `glm-5.3-flash` 不变,wire 侧按模型目录映射。

```mermaid
flowchart TB
    subgraph USER["用户端"]
        BROWSER["浏览器 · Console SPA(React)"]
        CLIENT["API 客户端 · 脚本 / SDK"]
    end

    subgraph EDGE["Cloudflare 边缘"]
        ACCESS["Cloudflare Access(Zero Trust)<br/>邮箱 OTP / GitHub 等方式登录"]
    end

    subgraph CONSOLE["nano-console Worker · apps/console"]
        SPA["Workers Static Assets<br/>托管 SPA,路由回退由平台处理"]
        PROXY["/glm/* 代理(worker 接管)<br/>① 校验 Access JWT(JWKS · iss / aud)<br/>② 注入 Bearer GLM_API_KEY(secret)<br/>③ 剥离 cookie / cf-* 等头<br/>④ SSE 响应流式透传,不缓冲"]
    end

    subgraph APIW["nano-api Worker · apps/api(Hono)"]
        ROUTES["/v1 路由 · 全局 Bearer API_KEY 认证<br/>agents · skills · sessions · environments"]
        SERVICE["service 业务层<br/>zod 校验 · copy-on-write 版本策略"]
    end

    subgraph RUNTIME["会话运行时(每个 Session)"]
        DO["SESSION_DO · Durable Object<br/>状态机 + 事件历史 + SSE 推流<br/>+ turn 执行器(自管检查点与恢复)"]
        SANDBOX["Sandbox SDK 会话沙箱<br/>read · write · edit · bash · grep · find · ls"]
    end

    subgraph STORE["Cloudflare 存储"]
        D1[("D1 · nano-api-db(绑定 DB)<br/>元数据:agents · skills · environments · sessions")]
        R2[("R2 · nano-files(绑定 FILES)<br/>会话产出文件")]
    end

    subgraph EXT["上游服务"]
        GLM_API["GLM Managed Agents API<br/>agent-api.bigmodel.cn(仅 console /glm 代理)"]
        GLM_LLM["Cloudflare AI Gateway REST API<br/>/ai/v1/chat/completions · @cf/zai-org 模型"]
    end

    BROWSER -->|"登录"| ACCESS
    ACCESS -->|"放行(Cf-Access-Jwt-Assertion)"| SPA
    BROWSER -->|"管理操作 /glm/*"| PROXY
    PROXY -->|"转发(补 zai-version / zai-beta 头)"| GLM_API
    GLM_API ==>|"SSE 事件流(经代理透传)"| BROWSER

    CLIENT -->|"Bearer API_KEY"| ROUTES
    ROUTES --> SERVICE
    SERVICE -->|"Drizzle ORM"| D1
    SERVICE -->|"创建 Session / 追加事件"| DO
    DO -->|"模型请求(context + 工具定义,流式)"| GLM_LLM
    GLM_LLM -->|"流式增量 / 响应"| DO
    DO -->|"工具调用"| SANDBOX
    SANDBOX -->|"产出文件"| R2
    DO ==>|"SSE · /sessions/:id/events/stream"| CLIENT
```

代码分层(`apps/*` 是传输层,`packages/db` 是唯一 SQL 出处,`packages/shared` 是协议层):

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| console worker(代理 + Access 校验) | `apps/console/src/worker/` | 接管 `/glm/*`,转发 GLM |
| console SPA | `apps/console/src/web/` | 管理界面(agents / sessions / skills / files / memories / vaults …) |
| api worker | `apps/api/src/` | Hono `/v1` 路由、auth、错误信封 |
| Drizzle schema + repo | `packages/db/src/` | 全部 SQL 与事务边界 |
| zod 协议 + GLM DTO | `packages/shared/src/` | 前后端共用类型 |

## 2. nano-api 请求链路

通用骨架:requestId 中间件 → Bearer 认证(常数时间比较)→ 模块路由 → zod 解析 → service → Drizzle repo → D1;任何一层抛错都由 `onError` 统一包装成 GLM 风格错误信封(含 `request_id`)。

Agent 更新走 **copy-on-write**:版本行是不可变快照,更新 = 插入新版本行 + CAS 前移 `agents.current_version` 指针,两条语句放进同一个 D1 batch(SQLite 隐式事务);期间被并发修改则守卫条件落空、两条语句空转,上层转 409。

```mermaid
flowchart TB
    REQ(["API 客户端请求<br/>以 POST /v1/agents/:agentId(更新)为例"]) --> RID["requestId 中间件<br/>生成 request_id"]
    RID --> AUTH{"auth 中间件<br/>Bearer vs API_KEY(secret)<br/>常数时间比较"}
    AUTH -->|"缺失 / 不匹配"| E401["401 unauthorized"]
    AUTH -->|"通过"| ROUTE{"Hono 路由 /v1"}

    ROUTE -->|"POST /v1/agents/:agentId"| PARSE["handler · body.ts zod 解析<br/>AgentUpdateInput(merge patch)"]
    ROUTE -->|"GET 列表 / 详情 / 版本历史"| READ["repo 读取<br/>agents JOIN agent_versions(current_version)<br/>keyset 分页 · 游标 (created_at, id)"]
    ROUTE -->|"POST /v1/skills(multipart zip)等"| SKILL["zip 解析 + frontmatter 提取<br/>skill_versions + skill_files 同 batch 写入"]

    READ --> SER["serializer → 200<br/>对象 JSON / Page&lt;T&gt;(opaque next_page 游标)"]
    SKILL --> SER

    PARSE -->|"schema 不符"| E400["400 invalid_request_error"]
    PARSE -->|"通过"| LOAD["service.findCurrentAgent<br/>当前配置快照"]
    LOAD -->|"不存在"| E404["404 not_found"]
    LOAD -->|"命中"| SKILLREF{"skills 引用校验<br/>findMissingSkillVersionPairs<br/>(skill_id, version) 全部存在?"}
    SKILLREF -->|"缺失"| E400R["400 · 引用不存在的 skill 版本"]
    SKILLREF -->|"通过"| MERGE["merge patch 当前配置<br/>→ NormalizedAgentConfig"]
    MERGE --> BATCH

    subgraph BATCH["repo.insertNextVersionAndAdvance · 同一 D1 batch(隐式事务)"]
        G1["① 守卫式 INSERT … SELECT<br/>FROM agents<br/>WHERE current_version = expected<br/>AND archived_at IS NULL<br/>→ 插入不可变的新版本行"]
        G2["② CAS UPDATE agents<br/>SET current_version = expected + 1<br/>WHERE current_version = expected<br/>AND archived_at IS NULL"]
        G1 ~~~ G2
    end

    BATCH --> CHK{"UPDATE meta.changes > 0 ?"}
    CHK -->|"是"| OK["200 · 返回新版本 Agent 对象"]
    CHK -->|"否 · 期间被并发修改"| E409["409 · 版本冲突"]
    CHK -->|"否 · agent 已归档"| EARCH["400 · 已归档"]

    E401 & E400 & E404 & E400R & E409 & EARCH --> ONERR["onError 统一包装<br/>GLM 风格错误信封(含 request_id)"]
    OK --> DONE([响应返回])
    SER --> DONE
    ONERR --> DONE
```

关键实现:`apps/api/src/routes/v1.ts`(认证与挂载)、`apps/api/src/modules/agent/service.ts`(业务规则与冲突转译)、`packages/db/src/agent/repo.ts:170`(`insertNextVersionAndAdvance`)。归档是幂等的终止操作,没有取消归档路径。

## 3. D1 数据模型

五张表、两组"实体 + 不可变版本快照"结构。Agent 对 Skill 的引用不是外键,而是 `agent_versions.skills` JSON 列中的 `SkillReference{skill_id, version}`,写入时由 `findMissingSkillVersionPairs` 校验存在性。

```mermaid
erDiagram
    agents {
        text id PK "agent_ + UUIDv7"
        integer current_version "当前版本指针(CAS 前移)"
        integer archived_at "NULL = 未归档;幂等且不可逆"
        integer created_at
        integer updated_at
    }
    agent_versions {
        text agent_id PK, FK "→ agents.id"
        integer version PK "与 agent_id 组成复合主键"
        text name
        text description
        text system "系统提示词"
        text model_id "glm-5.3 / glm-5.3-flash"
        text model_effort "low / high / max"
        text model_speed
        text tools "JSON · NormalizedAgentToolset 数组"
        text skills "JSON · SkillReference 数组(软引用)"
        text mcp_servers "JSON · McpServer 数组"
        text metadata "JSON"
        integer created_at
        integer updated_at
    }
    skills {
        text id PK "skill_ + UUIDv7"
        text display_title
        text source "单租户恒为 custom"
        integer latest_version_seq "NULL = 空壳(版本全删)"
        integer next_version "版本号分配器,只增不减"
        integer created_at
        integer updated_at
    }
    skill_versions {
        text skill_id PK, FK "→ skills.id"
        integer version PK "与 skill_id 组成复合主键"
        text id "skv_ + UUIDv7 · 唯一回显 id"
        text name "frontmatter 解析结果"
        text description
        text directory
        integer file_count
        integer total_bytes
        text content_sha256
        integer created_at
    }
    skill_files {
        text skill_id PK, FK "→ skills.id"
        integer version PK "与 skill_id · path 组成复合主键"
        text path PK "规范树内相对路径"
        blob content "文件字节"
        integer size
        text sha256
    }

    agents ||--o{ agent_versions : "1 个 agent 多个不可变版本快照"
    skills ||--o{ skill_versions : "1 个 skill 多个目录快照(元数据)"
    skills ||--o{ skill_files : "1 个 skill 多个目录快照(文件内容)"
    agents }o..o{ skills : "agent_versions.skills JSON 软引用"
```

约束要点:

- 版本行写入后不可变,任何更新都产生新版本,绝不改写历史快照。
- `skill_versions` 与 `skill_files` 在同一个 D1 batch 中写入 / 删除,保证目录快照原子。
- 分页统一走 keyset 游标(agents 按 `(created_at, id)`,版本列表按 `version` 单列),游标以 opaque `next_page` 形式返回。
