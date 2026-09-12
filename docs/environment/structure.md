# Environment 模块代码目录结构

本文档描述 Environment 模块的代码目录结构，把 [schema.md](schema.md) 中设计的一张表和 [api/](api/) 中定义的六个端点，落到 [Agent 模块结构](../agent/structure.md) 已经定下的三层骨架上。

Agent 模块立起了样板，Skill 模块演示了带 multipart 上传的偏离。Environment 模块**照抄这份骨架**，而且是三个资源里最贴近样板的一个：单表、纯 JSON、无版本。本文档不复述规则本身，只回答两件事：一是 Environment 模块在每个层上补了哪些文件（增量目录树）；二是它与 Agent 样板的两处形态差异从哪来——**没有版本快照，更新是单行就地覆盖；多了删除端点，终止操作分软硬两档**。理解这两处差异，加上 Agent 样板，就理解了 Environment 模块的全部结构。

## 设计目标

**骨架同构。** `modules/environment/` 内部仍是 `routes.ts` + `handlers/` + `service.ts` + `serialize.ts` 四种角色，文件命名与 `docs/environment/api/` 一一对应；`packages/db/src/environment/` 仍是 `ids.ts` + `repo.ts`。看懂 Agent 模块的人打开 Environment 模块不需要任何重新适应。

**归一化与合并纯函数化。** config 的默认值展开（六类包管理器补全、`allowed_hosts` 小写化排序去重）、更新语义（config 整体替换、metadata 键级合并）、无变化比较——这些不含任何 IO 的规则全部放在 `@nano/shared`，用 node 环境单测穷举。它们是 Environment 语义里最容易出错的部分（省略与 null 的区别、整体替换与深合并的混淆、联动校验的时机），必须在进入 Workers 集成测试之前钉死。

**联动校验收口在合并之后。** limited 网络下声明 packages 必须放行包管理器联网——这条规则作用于**合并后的完整配置**而非请求补丁（config 整体替换语义下两者等价，收口在合并结果是防御性选择：将来若引入部分更新语义，校验位置无需变动）。实现上把「校验合并结果」作为 service 更新链路的固定一步，schema 层只在创建侧做同规则的静态检查。

## 目录树（增量）

只列 Environment 模块新增与改动的位置；既有布局见 [Agent structure.md](../agent/structure.md) 的完整目录树。

```
nano-managed-agent/
├── apps/
│   └── api/                                  # @nano/api — 传输层
│       ├── src/
│       │   └── modules/
│       │       └── environment/              # [新增] Environment 资源模块, 内部骨架与 modules/agent 同构
│       │           ├── routes.ts             # Hono 子路由: 声明六个端点并绑定到对应 handler
│       │           ├── handlers/             # 每个端点一个文件, 与 docs/environment/api/ 下的文档一一对应
│       │           │   ├── create-environment.ts       # POST   /v1/environments
│       │           │   ├── list-environment.ts         # GET    /v1/environments
│       │           │   ├── get-environment.ts          # GET    /v1/environments/{environmentId}
│       │           │   ├── update-environment.ts       # POST   /v1/environments/{environmentId}
│       │           │   ├── archive-environment.ts      # POST   /v1/environments/{environmentId}/archive
│       │           │   └── delete-environment.ts       # DELETE /v1/environments/{environmentId}
│       │           ├── service.ts           # 业务编排: 归档检查、合并补丁、无变化检测、联动校验
│       │           └── serialize.ts         # 数据库行转 API JSON: 时间戳转 ISO, 注入 type 与 scope 字段
│       └── test/
│           └── environments/                # 集成测试: 真实 Workers 运行时加 miniflare D1
│               ├── helpers.ts               # 测试夹具: 应用迁移, 构造合法 payload, 断言错误信封
│               ├── create-environment.test.ts
│               ├── list-environment.test.ts
│               ├── get-environment.test.ts
│               ├── update-environment.test.ts
│               ├── archive-environment.test.ts
│               └── delete-environment.test.ts
├── packages/
│   ├── shared/                               # @nano/shared — 协议层
│   │   ├── src/
│   │   │   └── environment/                  # [新增] Environment 资源的协议定义与纯函数
│   │   │       ├── schemas.ts                # 创建/更新请求的 zod schema 及推导类型, 含 config 的嵌套结构
│   │   │       ├── normalize.ts              # 归一化纯函数: config 默认值展开, hosts 小写化排序去重
│   │   │       └── merge.ts                  # 合并纯函数: 更新语义与无变化比较
│   │   └── test/environment/                 # 纯函数单测, node 环境运行, 不需要 Workers
│   │       ├── schemas.test.ts
│   │       ├── normalize.test.ts
│   │       └── merge.test.ts
│   └── db/                                   # @nano/db — 存储层
│       └── src/
│           ├── schema.ts                     # [改动] 追加 environments 单表
│           └── environment/                  # [新增]
│               ├── ids.ts                    # newEnvironmentId(): 生成 env_ 前缀加 UUIDv7 的资源标识
│               └── repo.ts                   # 全部 Environment SQL 的唯一出处, 六个仓储函数对应六条读写路径
```

另有一处全局改动：`apps/api/src/routes/v1.ts` 追加一行 `v1.route("/environments", environmentRoutes)`（替换现有的「后续挂载」占位注释）。

## 各层内部结构

### packages/shared：协议层

**`schemas.ts`** 是 Environment 资源所有请求与响应结构的唯一权威定义：`EnvironmentCreateRequest`、`EnvironmentUpdateRequest`、`EnvironmentConfigInput`（type + 可空 packages + 可空 networking）、`EnvironmentPackagesInput`（六类可空数组）、`EnvironmentNetworkingInput`（unrestricted / limited 的 oneOf tagged union）、`Metadata` / `MetadataPatch`，以及响应侧的 `Environment` / `EnvironmentConfigResponse` 类型。长度限制与枚举这类单字段约束直接写在 schema 上；所有对象 `.strict()` 对齐 OpenAPI 的 `additionalProperties: false`——config 内出现未支持的字段（包括 `self_hosted`、自定义 registry 配置）一律 400。limited 与 packages 的联动规则**不**挂在这里（它作用于合并后的完整配置，时机在 merge 之后，见 service 一节）。

**`normalize.ts`** 把允许大量省略的输入补全为完全展开的形态：`config` 省略或 null 展开为 `{type: "cloud", 空 packages, unrestricted}`；packages 六类列表省略或 null 补为空数组、重复项去重（保留首次出现顺序）；networking limited 的 `allowed_hosts` 小写化、排序、去重，两个联网开关补为具体布尔值。归一化的输出同时是数据库的存储形态和 API 的响应形态——这是 [schema.md](schema.md)「落库即归一化」原则的实现位置。

**`merge.ts`** 实现更新语义：接收当前落库形态与本次补丁，按 GLM 的规则合并出候选行——`name` / `description` 标量整体替换（description 可 null 清空）；**`config` 整体替换**（null 恢复默认 cloud 配置，替换值先过 normalize）；`metadata` 按键合并（null 删键）。同文件中的 `environmentEquals` 用于无变化检测：候选行与当前行逐字段一致时更新接口不写库。文件内还包含 `assertConfigConsistent`：对合并后的完整 config 检查「limited 且六类 packages 任一非空时 `allow_package_managers` 必须为 true」，不满足时返回结构化的校验错误（由 service 转 400）。

### packages/db：存储层

`schema.ts` 追加 [schema.md](schema.md) 定义的 `environments` 单表；`environment/ids.ts` 与 `agent/ids.ts` 同构，前缀为 `env_`。

`environment/repo.ts` 对外暴露六个仓储函数，每个函数对应一条完整的业务读写路径：

```ts
createEnvironment(db, { id, name, description, config, metadata, now })
findEnvironment(db, environmentId)
listEnvironmentsPage(db, { limit, order, cursor })
updateEnvironment(db, { environmentId, name, description, config, metadata, now })
archiveEnvironment(db, environmentId, now)
deleteEnvironment(db, environmentId)
```

- `createEnvironment` 单条 INSERT，写入的 config 已是归一化形态；没有跨表一致性要求，也就不需要 batch（对照 Agent 创建的两表 batch 与 Skill 创建的分块文件行）。
- `findEnvironment` 按 id 点查，查不到返回 null，由上层决定转成 404；获取、更新、归档、删除四个端点共用。
- `listEnvironmentsPage` 按 `(created_at, id)` keyset 分页。游标编解码复用 `apps/api/src/lib/pagination.ts`（payload 类型前缀 `environments:`），repo 接收解码后的普通参数，不关心游标内容。
- `updateEnvironment` 接收 service 合并好的**完整字段**（不是补丁），以 `WHERE id = ? AND state = 'active'` 单条 UPDATE；受影响行数为 0 时返回 false，由 service 重读一次区分 404（行已不存在）与 400（并发窗口内被归档）。
- `archiveEnvironment` 以 `WHERE id = ? AND state = 'active'` 同时写入 `state = 'archived'` 与 `archived_at`，天然幂等；重复归档 0 行受影响，调用方直接返回当前行。
- `deleteEnvironment` 按 id 硬删，不做引用计数（与 GLM 一致，见 [api/delete-environment.md](api/delete-environment.md)）；受影响 0 行返回 false 转 404。

### apps/api：传输层

`modules/environment/` 四种角色的分工与 Agent 一致，差异只在内容：

- `handlers/` 与 Agent 完全同构：shared schema 解析入参（update 的 requestBody 可为空，缺省视为空补丁）、调 service、serialize 后以 JSON 响应；创建 201，其余 200。
- `service.ts` 的判定链比 Agent 短一截（没有版本与 CAS）。以 `updateEnvironment` 为例：取当前行（null → 404）→ 已归档（400）→ merge 合并补丁 → `assertConfigConsistent` 联动校验（不满足 → 400）→ 无变化则直接返回现状（不写库、`updated_at` 不变）→ repo 就地覆盖（返回 false 时重读区分 404 / 400）。创建链路则是：schema 校验 → normalize → 生成 ID → 落库。
- `serialize.ts` 做行到 API JSON 的最后一跳：时间戳转 ISO 8601 UTC、`state` / `archived_at` 直读，并注入两个不落库的固定字段——`type: "environment"` 与 `scope: "organization"`。序列化只此一处，保证六个端点回显的 Environment 形状完全一致。

`lib/` 无新增：分页、认证、request_id、错误信封、body 解析全部复用既有横切设施。

## 一个请求的完整旅程

以更新 Environment（`POST /v1/environments/{environmentId}`）为例：

1. Worker 入口 `index.ts` 接到请求。request-id 中间件先生成 `request_id`，auth 中间件校验 Bearer 凭证，不通过则以 401 结束。
2. 路由经过 `routes/v1.ts` 进入 `modules/environment/routes.ts`，命中 `handlers/update-environment.ts`。
3. handler 用 `EnvironmentUpdateRequest` schema 解析请求体（单字段约束与 `.strict()` 都在这一步完成，非法请求以 400 结束，错误信息带字段路径）。
4. handler 调用 `service.updateEnvironment`：取当前行、归档检查、merge 合并、联动校验、无变化检测，最后调 `updateEnvironment` repo 就地覆盖。任一环节不满足条件，都以 `ApiError` 抛出，对应 404 或 400（本模块没有 409 路径）。
5. 成功路径上，service 返回更新后的行，`serialize.ts` 转成 API JSON，handler 以 200 返回。
6. 任何环节抛出的 `ApiError` 由 `app.onError` 兜底，统一渲染成带 `request_id` 的错误信封。

## 测试策略

纯函数单测放在 `packages/shared/test/environment/`，node 环境毫秒级：`schemas.test.ts` 覆盖 `.strict()` 的未知字段拒绝、`self_hosted` 拒绝、包名 / 主机名的非法形态；`normalize.test.ts` 覆盖 config 省略展开、六键补全、去重保序、hosts 小写化排序去重；`merge.test.ts` 穷举更新语义（省略不变、null 清空 / 恢复默认、config 整体替换、metadata 键级合并、无变化比较）与联动校验的时机（对合并后配置生效）。

集成测试放在 `apps/api/test/environments/`，真实 Workers 运行时 + miniflare D1，`helpers.ts` 复用 agents / skills 的夹具模式。除六个端点的契约（创建归一化回显、分页游标往返、404、更新语义逐条、归档幂等与归档后拒更、删除回执）外，两个专项：`update-environment.test.ts` 构造「保留 packages、切到 limited 未放行」的请求断言 400（联动校验作用于合并结果的端到端验证）；`archive-environment.test.ts` 补「归档后删除仍可成功」的路径。

## 对样板的偏离点

与 Agent 模块逐条对照，Environment 模块的形态差异只有两处，其余全部照抄：

| 偏离 | Agent | Environment | 根因 |
| --- | --- | --- | --- |
| 版本模型 | 两张表，不可变版本快照 + `version` CAS（409） | 单表，就地覆盖，最后写入获胜 | GLM Environment 无 `version` 字段与列版本端点；快照固化发生在 Session 侧 |
| 终止操作 | 仅归档（无 delete 端点） | 归档（软）+ 硬删除（无引用计数） | GLM 语义：归档阻止新绑定，delete 移除记录且不查引用 |

另有一处表述级差异：serialize 注入的固定字段是 `type` + `scope`（Agent 是 `type` + `multiagent`），根由是两种资源的 wire format 固定字段不同，不构成结构偏离。

## 演进预留

- **Session 引用与快照固化**：Session 模块引入后，创建会话时把环境的当前 config 固化为会话侧快照；归档 / 删除的会话联动（终止 / not found）在那一侧实现。本模块的表结构与 repo 接口不需要改动。
- **`self_hosted` 配置形态**：GLM 当前拒绝 `config.type: "self_hosted"`；将来放开时只需扩展 `EnvironmentConfigInput` 的枚举与归一化分支，存储形态（JSON 列）天然容纳。
- **`scope` 多租户**：字段当前是序列化注入的常量。若引入多租户，把 `scope` 改为落库列并加归属者字段即可，wire format 不变。
