# Environment 模块实现计划

本计划依据 [structure.md](structure.md) 定下的三层结构与目录布局，把 Environment 模块的实现拆成七个里程碑：六个按接口竖切的阶段、一个收尾阶段。每个竖切阶段交付一个可以实际调用、带完整测试的端点，对应 `docs/environment/api/` 下的一份接口文档。

## 总体思路

**无需地基阶段。** Agent 模块的 M0 已经把横切设施建齐（`lib/` 下的错误信封、request_id、认证、分页、body 解析），Skill 模块又验证了它们对第二个资源的复用。Environment 模块的地基工作只剩一张表的迁移，并入第一个竖切里程碑。

**按接口竖切。** 每个端点的实现完整穿过三层：协议层补上它需要的 schema 与纯函数，存储层补上仓储函数，传输层补上 handler 与 service 方法。做完一个里程碑，对应接口就处于可交付状态；验收方式是拿接口文档逐条对照行为。

**顺序有依赖考量。** 创建接口放第一，负责把模块骨架（routes、service、serialize、handlers 目录）与建表迁移立起来。更新接口放归档之前，因为归档的回归测试需要「归档后更新被拒」这条端到端路径。删除放最后——它是语义上最轻的端点（一条 DELETE），放在归档之后还能顺带验证「归档后仍可删除」。获取和列表互相独立，可以并行。

**纯函数先行、测试穷举。** 每个里程碑里属于 `@nano/shared` 的部分（schema 校验、归一化、合并）先于集成代码完成并配齐 node 单测。Environment 语义里最容易出错的部分——省略与 null 的区别、config 整体替换与深合并的混淆、联动校验的时机——都在这些纯函数里，单测先行能在进入 Workers 集成测试之前把语义钉死。

## 里程碑总览

| 里程碑 | 交付能力 | 对应接口文档 | 规模 |
| --- | --- | --- | --- |
| M1 创建 | `POST /v1/environments`（含建表迁移与模块骨架） | [create-environment.md](api/create-environment.md) | 大 |
| M2 获取 | `GET /v1/environments/{environmentId}` | [get-environment.md](api/get-environment.md) | 小 |
| M3 列表 | `GET /v1/environments` | [list-environment.md](api/list-environment.md) | 小 |
| M4 更新 | `POST /v1/environments/{environmentId}` | [update-environment.md](api/update-environment.md) | 大 |
| M5 归档 | `POST /v1/environments/{environmentId}/archive` | [archive-environment.md](api/archive-environment.md) | 小 |
| M6 删除 | `DELETE /v1/environments/{environmentId}` | [delete-environment.md](api/delete-environment.md) | 小 |
| M7 收尾 | 全量验收，接口行为与文档逐条核对 | 全部 | 小 |

规模一列只是相对体量：M1 从零立骨架并承载归一化语义，M4 承载更新语义与联动校验，两者标注「大」；其余四个是在既有骨架上补仓储函数和 handler 的「小」里程碑。

依赖关系如下，M2 与 M3 互相独立可以并行，M6 只依赖 M1（放在 M5 之后是为了回归覆盖「归档后可删」）：

```
M1 → M2 → M3 → M4 → M5 → M6 → M7
     └───────┘（可并行）
```

## 通用工作约定

以下约定适用于每个里程碑，后文不再重复：

- **完成定义（DoD）**：`pnpm typecheck` 与 `pnpm test` 全绿；本里程碑新增测试全部通过；接口行为对照对应文档的「错误行为」表和请求 / 响应示例逐条核对过；`pnpm dev` 起本地服务后用 curl 冒烟通过。
- **提交粒度**：一个里程碑至少一个提交；M1、M4 这类大里程碑建议按 shared → db → api 分成三个提交，便于回溯。
- **迁移纪律**：M1 改了 `packages/db/src/schema.ts`，必须紧接着运行 `pnpm db:generate` 生成迁移并提交，不允许 schema 与迁移脱节。
- **测试先行部分**：涉及 `@nano/shared` 纯函数的任务，先写单测用例清单再写实现。

---

## M1 创建 Environment — `POST /v1/environments`

第一片竖切：建表、立协议层纯函数、把 `modules/environment` 的骨架立起来。后续五个端点照此复制。

**存储层：**

- [x] 在 `packages/db/src/schema.ts` 中按 [schema.md](schema.md#drizzle-定义落地到-packagedbsrctschemats) 的定义追加 `environments` 单表。JSON 列的 `$type<>()` 此阶段可先用宽松类型占位，随后回填为 shared 推导的具体类型。
- [x] 新建 `packages/db/src/environment/ids.ts`：实现 `newEnvironmentId()`，`env_` 前缀加 UUIDv7（复用 `agent/ids.ts` 的实现方式）。
- [x] 运行 `pnpm db:generate` 生成迁移，`pnpm db:migrate:local` 在本地跑通，确认表按预期创建（含 `idx_environments_created_at_id` 索引）。
- [x] 新建 `packages/db/src/environment/repo.ts`：实现 `createEnvironment`（单条 INSERT，写入已归一化的 config）。

**协议层：**

- [x] 新建 `packages/shared/src/environment/schemas.ts`：定义 `EnvironmentCreateRequest`、`EnvironmentConfigInput`（type 仅 cloud）、`EnvironmentPackagesInput`（六类可空数组，每类 ≤ 200 项、单项约束）、`EnvironmentNetworkingInput`（unrestricted / limited oneOf，limited 三字段）、`Metadata`，并导出 `z.infer` 类型。所有对象 `.strict()` 对齐 `additionalProperties: false`。同时定义响应侧的 `Environment` / `EnvironmentConfigResponse` 类型。规则清单以 [create-environment.md](api/create-environment.md) 的 OpenAPI 为准。
- [x] 新建 `packages/shared/src/environment/normalize.ts`：实现 `normalizeEnvironmentConfig`，把省略形态补全为展开形态（config null 展开 cloud 默认、六键补空数组并去重、hosts 小写化排序去重、联网开关补布尔值），输出类型即落库形态。
- [x] 单测：`schemas.test.ts` 覆盖创建侧全部校验规则（`self_hosted` 拒绝、未知字段拒绝、包名含空白 / 以 `-` 开头 / 超 256、allowed_hosts 带协议 / 端口 / 路径 / 超 255、metadata 超限）；`normalize.test.ts` 覆盖 config 省略展开、六键补全、重复项去重保序、hosts 小写化排序去重。

**传输层：**

- [x] 建立 `apps/api/src/modules/environment/` 骨架：`routes.ts`（声明 `POST /v1/environments`）、`serialize.ts`（行转 API JSON，注入 `type: "environment"` 与 `scope: "organization"`，时间戳转 ISO）、`service.ts`（首个方法 `createEnvironment`：校验 → 归一化 → 生成 ID → 落库）、`handlers/create-environment.ts`。
- [x] 在 `routes/v1.ts` 挂载 `v1.route("/environments", environmentRoutes)`，移除「后续挂载 environments」的占位注释。

**测试与验收：**

- [x] 集成测试 `create-environment.test.ts`：创建成功返回 201，响应逐字段对照文档示例（归一化回显：六键全出现、未声明为空数组、`state: "active"`、`scope: "organization"`、`archived_at: null`）；只提交 `name` 时 config 回显 cloud 默认形态；缺 name 返回 400；`config.type: "self_hosted"` 返回 400；config / packages / networking 内未知字段返回 400；包名以 `-` 开头、allowed_hosts 写 `https://github.com`（带协议）分别返回 400；limited 声明 packages 但未显式 `allow_package_managers: true` 返回 400；metadata 超 16 键返回 400；不带凭证返回 401。
- [x] curl 冒烟：用文档「请求示例」原样创建一次，肉眼比对响应。

---

## M2 获取 Environment — `GET /v1/environments/{environmentId}`

- [x] `repo.ts` 新增 `findEnvironment(db, environmentId)`：按 id 点查，查不到返回 null。
- [x] `service.ts` 新增 `getEnvironment`：取不到抛 404 的 `ApiError`。
- [x] 新建 `handlers/get-environment.ts` 并在 `routes.ts` 注册路由。
- [x] 集成测试 `get-environment.test.ts`：创建后按返回的 id 获取，字段与创建响应完全一致；不存在的 id 返回 404 且响应是完整错误信封；path 参数为任意合法字符串同样 404 而不是 500；不带凭证 401。

**验收**：响应形状与 [get-environment.md](api/get-environment.md) 的示例一致；404 行为符合「无权限与不存在同返回 404」的语义（单租户下即不存在 → 404）。

---

## M3 列出 Environment — `GET /v1/environments`

分页设施已由 Agent 模块建好，本里程碑只是注册使用。

- [x] `repo.ts` 新增 `listEnvironmentsPage(db, {limit, order, cursor})`：按 `(created_at, id)` keyset 查询，返回本页数据与下一页游标。
- [x] 确认 `lib/pagination.ts` 的游标 payload 类型前缀覆盖 `environments:`（防与其他列表端点的游标混用）。
- [x] `service.ts` 新增 `listEnvironments`；新建 `handlers/list-environment.ts`；响应体为 `{ data, next_page }`。
- [x] 集成测试 `list-environment.test.ts`：造 25 个 Environment，默认参数返回 20 条、按创建时间倒序、`next_page` 非空；携带游标翻到第 2 页拿到剩余 5 条且 `next_page` 为 null；`limit=5` 生效；`limit=200` 被截断为 100；`limit=0` 返回 400；`order=asc` 正序；篡改游标内容返回 400；已归档的 Environment（用 helpers 直改库造一个）仍出现在列表中。

**验收**：分页行为逐条对照 [list-environment.md](api/list-environment.md) 与 [README.md](api/README.md#分页) 的约定（注意 `order` 是 nano 对 GLM 的补充参数）。

---

## M4 更新 Environment — `POST /v1/environments/{environmentId}`

语义最重的里程碑。config 整体替换、metadata 键级合并、联动校验的时机、无变化检测，都集中在这里，纯函数单测是本阶段的重点。

**协议层（先行）：**

- [x] `schemas.ts` 补充 `EnvironmentUpdateRequest`：`name` / `description` 替换语义（description 可 null 清空）、`scope` null / 省略不变、`config` nullable（null 恢复默认）、`MetadataPatch`（值为 null 表示删键）。
- [x] 新建 `packages/shared/src/environment/merge.ts`：实现 `mergeEnvironmentRecord(current, patch)`（标量替换、config 整体替换且替换值先过 normalize、metadata 键级合并）、`environmentEquals(a, b)`、`assertConfigConsistent(config)`（limited 且六类 packages 任一非空时必须 `allow_package_managers: true`，返回结构化校验错误）。
- [x] `merge.test.ts` 穷举单测：省略字段保持不变；description 传 null 清空而 name 不可清空；config 传新值整体替换（此前其他管理器的包消失）、传 null 恢复 cloud 默认、省略不变；metadata 新键新增、旧键覆盖、null 值删键、未提及键保留；合并结果与当前一致时 `environmentEquals` 为真、任何一处不同则为假；联动校验对「保留 packages、切到 limited 未放行」的合并结果报错、对显式放行的结果放行。

**存储层：**

- [x] `repo.ts` 新增 `updateEnvironment(db, {environmentId, name, description, config, metadata, now})`：接收合并后的完整字段，`WHERE id = ? AND state = 'active'` 单条 UPDATE；受影响行为零时返回 false。

**传输层：**

- [x] `service.ts` 新增 `updateEnvironment`，判定链按 structure.md 的顺序实现：取当前行（null → 404）→ 已归档（400）→ merge 合并 → `assertConfigConsistent`（不满足 → 400）→ 无变化则直接返回现状（不写库、`updated_at` 不变）→ repo 覆盖（返回 false 时重读一次区分 404 与并发归档 400）。
- [x] 新建 `handlers/update-environment.ts` 并注册路由；空请求体（`{}`）视为合法空补丁。

**测试与验收：**

- [x] 集成测试 `update-environment.test.ts`：只改 description 其余不变；config 整体替换后未提及的管理器列表清空、`allowed_hosts` 小写化排序去重回显、`allow_mcp_servers` 省略补 false；config 传 null 恢复 cloud 默认；description 传 null 清空；metadata 合并与删键；提交与当前完全相同的配置不写库、`updated_at` 不变；替换 config 声明 packages 且切 limited 未放行返回 400、显式 `allow_package_managers: true` 成功；已归档环境更新返回 400（用 helpers 直改库造归档状态）；不存在的 id 返回 404。
- [x] curl 冒烟：按 [update-environment.md](api/update-environment.md) 的请求示例走一遍整体替换。

---

## M5 归档 Environment — `POST /v1/environments/{environmentId}/archive`

- [x] `repo.ts` 新增 `archiveEnvironment(db, environmentId, now)`：`WHERE id = ? AND state = 'active'` 同时写 `state = 'archived'` 与 `archived_at`，天然幂等。
- [x] `service.ts` 新增 `archiveEnvironment`：归档后返回当前完整 Environment（`state` / `archived_at` 已填充）；重复调用返回相同结果。
- [x] 新建 `handlers/archive-environment.ts` 并注册路由。
- [x] 集成测试 `archive-environment.test.ts`：归档后 `state` 为 `archived`、`archived_at` 填充且后续获取不再变化；重复归档返回相同响应；归档后 `GET` 仍可读、列表中仍出现；`updated_at` 不因归档而变化；**端到端回归**：归档后调用更新接口返回 400（补上 M4 留下的真实路径验证）；不存在的 id 返回 404。

---

## M6 删除 Environment — `DELETE /v1/environments/{environmentId}`

- [x] `repo.ts` 新增 `deleteEnvironment(db, environmentId)`：按 id 硬删，受影响行为零时返回 false；**不做任何引用检查**（与 GLM 一致，见 [delete-environment.md](api/delete-environment.md)）。
- [x] `service.ts` 新增 `deleteEnvironment`：删除成功返回 `{id, type: "environment_deleted"}` 回执；不存在抛 404。
- [x] 新建 `handlers/delete-environment.ts` 并注册路由。
- [x] 集成测试 `delete-environment.test.ts`：删除后返回回执信封；再 `GET` / 更新 / 归档均 404；列表中不再出现；**归档后的环境仍可删除**（依赖 M5 造状态）；重复删除同一 id 返回 404；不存在的 id 返回 404。

---

## M7 收尾与验收

- [x] 对照六份接口文档做一次系统核对：每个端点的响应字段与 OpenAPI 的 required 列表一致；`type: "environment"` 与 `scope: "organization"` 在所有响应中恒定；config 回显恒为归一化完整形态（六键全出现）；错误信封在所有非 2xx 中格式一致且带 `request_id`。
- [x] 用 curl 按真实顺序走一遍生命周期：创建 → 获取 → 列表 → 更新（含一次整体替换与一次无变化）→ 归档 → 再次归档 → 删除，全程对照文档示例。
- [x] 全量 `pnpm test` 与 `pnpm typecheck`；确认迁移在全新本地库上从零应用成功（与 agents / skills 的既有迁移叠加）。
- [x] 复查依赖规则未被违反（modules 无横向引用、shared 零内部依赖、db 不 import api）。
- [x] 更新 `routes/v1.ts` 相关注释与 README 架构表中 environments 的实现状态（如有出入）。

---

## 风险与注意事项

以下几处是实现时最可能踩坑的地方，提前列出：

- **400 与 404 的分界**：`updateEnvironment` 的 UPDATE 受影响行为零有两种原因——行已不存在（404）与并发窗口内被归档（400）。repo 返回 false 时 service 需要重读一次区分，不能笼统抛同一种错误。
- **config 是整体替换，不是深合并**：实现时最容易顺手写成深合并（「只改 pip、保留 apt」）。语义是提交的 config 完全取代现有值；联动校验、无变化检测都以合并后的完整形态为基准。
- **联动校验的时机**：limited + packages 必须放行的规则作用于**合并后的完整配置**。config 整体替换语义下它与校验请求等价，但收口在合并结果——将来若引入部分更新语义，校验位置无需变动。
- **无变化检测的比较基准**：必须拿「归一化后的候选行」与「当前落库行」比，而不是拿原始请求比，否则用户提交已补全默认值的 config 会被误判为有变化。
- **allowed_hosts 的校验与规范化顺序**：先小写化再校验长度与格式（`API.Example.COM` 与 `api.example.com` 是同一个 host）；主机名按 ASCII hostname / `*.domain` 通配处理，GLM 未定义 IDN（国际化域名）行为，遇到非 ASCII 直接 400，不做 punycode 转换。
- **zod 的 unknown 键**：GLM 的 schema 都是 `additionalProperties: false`，zod 侧用 `.strict()` 对齐，否则多传字段的行为会与文档不符（自定义 registry / source / index URL 的拒绝正是依赖这条）。
- **删除不要顺手加引用检查**：GLM 明确不做引用计数，nano 保持一致；将来的引用缺失由消费方（Session 创建）在那一刻暴露为 not found。
