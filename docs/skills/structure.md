# Skill 模块代码目录结构

本文档描述 Skill 模块的代码目录结构，把 [schema.md](schema.md) 中设计的三张表和 [api/](api/) 中定义的九个端点，落到 [Agent 模块结构](../agent/structure.md) 已经定下的三层骨架上。

Agent 模块立起了样板：协议层、存储层、传输层的职责划分，资源模块之间禁止横向引用，纯函数沉到 `@nano/shared`。Skill 模块**照抄这份骨架**，本文档不再复述规则本身，只回答两件事：一是 Skill 模块在每个层上补了哪些文件（增量目录树）；二是它与 Agent 模块的三处形态差异从哪来——**传输层的输入不再是 JSON 而是 multipart 文件上传，存储层的主体不是配置 JSON 列而是文件行，序列化的输出除了 JSON 还有 ZIP 字节流**。理解这三处差异，加上 Agent 样板，就理解了 Skill 模块的全部结构。

## 设计目标

**骨架同构。** `modules/skill/` 内部仍是 `routes.ts` + `handlers/` + `service.ts` + `serialize.ts` 四种角色，文件命名与 `docs/skills/api/` 一一对应；`packages/db/src/skill/` 仍是 `ids.ts` + `repo.ts`。看懂 Agent 模块的人打开 Skill 模块不需要任何重新适应。

**上传解析与 ZIP 组装各自只有一处出处。** multipart 解析是所有「带文件上传」端点（Skill 创建、版本创建，将来的 File 资源）共享的能力，做成 `lib/multipart.ts` 横切设施；ZIP 组装是 Skill 特有的，放在模块内的 `zip.ts`。边界判据与 `lib/pagination.ts` 相同：是否会被第二个资源模块复用。

**规范树纯函数化。** 路径校验、单根剥离、frontmatter 解析、规范树哈希——这些不含任何 IO 的规则全部放在 `@nano/shared`，用 node 环境单测穷举。它们是 Skill 语义里最容易出错的部分（`..` 穿越、大小写、frontmatter 边界），必须在进入 Workers 集成测试之前钉死。

**跨资源引用检查沉到存储层。** Agent 侧校验 Skill 引用存在、Skill 侧删除前检查被引用，都要求读对方的表。`modules/` 之间禁止横向引用的约束不适用于 `packages/db`——db 层内部按表组织而非按模块组织，跨表查询是它的常态。两个方向的查询函数都收在 `packages/db/src/skill/repo.ts`，对上暴露业务语义（「这些引用是否可解析」「这个版本是否被引用」），Agent 与 Skill 的 service 层各自调用，谁也不 import 谁。

## 目录树（增量）

只列 Skill 模块新增与改动的位置；既有布局见 [Agent structure.md](../agent/structure.md) 的完整目录树。

```
nano-managed-agent/
├── apps/
│   └── api/                                   # @nano/api — 传输层
│       ├── src/
│       │   ├── lib/
│       │   │   └── multipart.ts               # [新增] multipart/form-data 解析包装:
│       │   │                                  #   提取文件字段与文本字段,坏请求统一转 invalid_request_error,
│       │   │                                  #   解析前按 Content-Length 预检上传上限,超限 413
│       │   └── modules/
│       │       └── skill/                     # [新增] Skill 资源模块,内部骨架与 modules/agent 同构
│       │           ├── routes.ts              # Hono 子路由: 声明九个端点并绑定到对应 handler
│       │           ├── handlers/              # 每个端点一个文件,与 docs/skills/api/ 下的文档一一对应
│       │           │   ├── create-skill.ts             # POST   /v1/skills
│       │           │   ├── list-skills.ts              # GET    /v1/skills
│       │           │   ├── get-skill.ts                # GET    /v1/skills/{skillId}
│       │           │   ├── create-skill-version.ts     # POST   /v1/skills/{skillId}/versions
│       │           │   ├── list-skill-versions.ts      # GET    /v1/skills/{skillId}/versions
│       │           │   ├── get-skill-version.ts        # GET    /v1/skills/{skillId}/versions/{version}
│       │           │   ├── download-skill-zip.ts       # GET    /v1/skills/{skillId}/versions/{version}/content
│       │           │   ├── delete-skill.ts             # DELETE /v1/skills/{skillId}
│       │           │   └── delete-skill-version.ts     # DELETE /v1/skills/{skillId}/versions/{version}
│       │           ├── service.ts            # 业务编排: 上传上限裁决、引用检查、CAS 冲突判定、指针重指
│       │           ├── serialize.ts          # 数据库行转 API JSON: 时间戳转 ISO, 注入 type, 版本号转字符串
│       │           └── zip.ts                # 规范树 → ZIP 字节流: <directory>/ 为根, path 排序, mtime 固定
│       └── test/
│           └── skills/                       # 集成测试: 真实 Workers 运行时加 miniflare D1
│               ├── helpers.ts                # 测试夹具: 应用迁移, 构造 multipart body, 断言错误信封
│               ├── create-skill.test.ts
│               ├── list-skills.test.ts
│               ├── get-skill.test.ts
│               ├── create-skill-version.test.ts
│               ├── list-skill-versions.test.ts
│               ├── get-skill-version.test.ts
│               ├── download-skill-zip.test.ts
│               ├── delete-skill.test.ts
│               └── delete-skill-version.test.ts
├── packages/
│   ├── shared/                               # @nano/shared — 协议层
│   │   ├── src/
│   │   │   └── skill/                        # [新增] Skill 资源的协议定义与纯函数
│   │   │       ├── schemas.ts                # Skill / SkillVersion 响应类型, SkillReference 复用 agent 侧定义
│   │   │       ├── frontmatter.ts            # SKILL.md frontmatter 解析: 提取 name/description, 其余键忽略
│   │   │       └── tree.ts                   # 规范树: 路径校验、单根剥离、上限常量、逐文件与整树哈希
│   │   └── test/skill/                       # 纯函数单测, node 环境运行, 不需要 Workers
│   │       ├── frontmatter.test.ts
│   │       └── tree.test.ts
│   └── db/                                   # @nano/db — 存储层
│       └── src/
│           ├── schema.ts                     # [改动] 追加 skills / skill_versions / skill_files 三张表
│           └── skill/                        # [新增]
│               ├── ids.ts                    # newSkillId() / newSkillVersionId(): skill_ / skv_ + UUIDv7
│               └── repo.ts                   # 全部 Skill SQL 的唯一出处, 含跨资源的引用检查查询
```

另有两处全局改动：`apps/api/src/routes/v1.ts` 追加一行 `v1.route("/skills", skillRoutes)`；`apps/api` 增加依赖 `fflate`（ZIP 组装，~8 KB，Workers 兼容）。`modules/agent` 在引用校验接入时有一次小改动（见 [work-plan](work-plan.md) M8），不引入新文件。

## 各层内部结构

### packages/shared：协议层

Skill 的请求不走 JSON，所以这里没有 Agent 那样的 `AgentCreateRequest` 型请求 schema；`schemas.ts` 只定义响应侧的 `SkillResponse`、`SkillVersionResponse` 类型与删除回执类型，供传输层序列化与前端共用。`SkillReference` 已在 `agent/schemas.ts` 定义，此处不重复。

**`tree.ts`** 是规范树的唯一权威。输入是「字段名 → 字节」的原始上传映射，输出是规范树：校验每条路径（相对、长度与段数上限、无 `..` / `\` / 控制字符 / `.git`）、执行单根剥离、确认 `SKILL.md` 在根、裁决文件数与总字节数上限、计算逐文件 SHA-256 与整树 `content_sha256`。上限常量（`MAX_FILES = 256`、`MAX_SKILL_FILE_BYTES = 1 MiB`、`MAX_TOTAL_BYTES = 20 MiB`、`MAX_PATH_LENGTH = 256` 等）从这里导出，传输层的预检、集成测试的构造、文档的数字都引用同一处。

**`frontmatter.ts`** 解析 `SKILL.md` 开头的 YAML frontmatter：必须以 `---` 行开始、存在闭合的 `---`；只提取 `name` 与 `description` 两个键做校验（`^[a-z0-9][a-z0-9-]{0,63}$` / 1–1024），其余键原样留在文件内容中。这里刻意不引入完整 YAML 库——frontmatter 的这两个键都是单行标量，一个十行的行解析器足够，也避免把任意 YAML 解析的攻击面带进 Worker。

### packages/db：存储层

`schema.ts` 追加 [schema.md](schema.md) 定义的三张表；`skill/ids.ts` 与 `agent/ids.ts` 同构，两个前缀（`skill_` / `skv_`）。

`skill/repo.ts` 对外暴露的仓储函数，按读写路径：

```ts
createSkillWithFirstVersion(db, { skillId, versionId, displayTitle, meta, tree, now })
findSkill(db, skillId)
listSkillsPage(db, { source, limit, order, cursor })
insertNextSkillVersionAndAdvance(db, { skillId, expectedVersion, versionId, meta, tree, now })
listSkillVersionsPage(db, skillId, { limit, order, cursor })
findSkillVersion(db, skillId, version)
listSkillFiles(db, skillId, version)                       // 按 path 有序,供 ZIP 组装
deleteSkillVersionAndRetarget(db, { skillId, version, now }) // batch: 文件行 + 版本行 + 指针重指
deleteSkillCascade(db, skillId)                            // batch: 三张表级联删
isSkillVersionReferenced(db, skillId, version)             // json_each 查活动配置(未归档 Agent 的当前版本)
isSkillReferenced(db, skillId)
findMissingSkillVersionPairs(db, refs)                     // Agent 侧存在性校验,返回缺失集合
```

- 文件行的批量写入**分块为 multi-row INSERT**（每块 ≤ 50 行、每行 6 个绑定参数），与版本元数据、指针更新放进同一个 D1 batch。事务边界与 Agent 模块一样收敛在 repo 内部，service 调用的始终是完整原子操作。
- `insertNextSkillVersionAndAdvance` 用**两阶段认领**实现版本号分配的并发安全：先以 `WHERE id = ? AND next_version = ?` 单独 CAS 认领（0 行受影响即返回 false，由 service 转 409），认领成功后一个 batch 写入版本行、文件行并前移 `latest_version_seq`。不能合并成「先插入、后 CAS」的单 batch——D1 batch 只对 SQL 错误回滚，对 0 行 UPDATE 照样提交，会留孤儿文件行。命名加 `Skill` 前缀是为了与 agent repo 的同语义函数在 `@nano/db` 汇总导出时避免同名冲突。
- 最后三个函数读的是 `agent_versions` 表。它们放在 skill repo 而非 agent repo，因为查询的发起方是 Skill 的删除路径与（经 agent service 调用的）存在性校验，语义是「Skill 引用关系的两个切面」；db 层按表组织不按模块组织，这不违反任何依赖规则。

### apps/api：传输层

**`lib/multipart.ts`** 是本模块引入的第一个新横切设施。它包装 Workers 原生的 `request.formData()`：先把上传映射拆成「文本字段」与「文件字段」两组（字段名即 Skill 内相对路径，`File.name` 被忽略）；解析前按 `Content-Length` 预检总量上限，解析后再按实际字节数复核一次，超限抛 `request_too_large`（413）；content-type 不是 multipart 或解析失败统一转 `invalid_request_error`。将来 File 资源或 Environment 的上传端点直接复用。

**`modules/skill/`** 四种角色的分工与 Agent 一致，差异只在内容：

- `handlers/` 里创建类端点先过 `lib/multipart.ts`，再把「文本字段 + 原始上传映射」交给 service；下载端点的 handler 不走 JSON 序列化，直接把 `zip.ts` 产出的字节以 `application/zip` 响应，并附 `content-disposition` 与 `etag` 头。
- `service.ts` 编排上传全链路：`tree.ts` 归一化（失败 → 400，超限 → 413）→ `frontmatter.ts` 提取元数据 → 生成 ID → repo 原子写入（CAS 失败 → 409）。删除路径先查引用（被引用 → 400），再走级联 batch。
- `serialize.ts` 做 Skill 行 / 版本行到 API JSON 的转写：时间戳转 ISO、注入 `type` 固定字段、`latest_version_seq` / `version` 整数转字符串（NULL 保持 null）。
- `zip.ts` 读 `listSkillFiles` 的有序行流，用 fflate 组装 ZIP：根目录一层 `<directory>/`，条目按 path 字典序，mtime 恒为版本 `created_at`。同一版本的任意两次下载字节一致。

## 一个上传请求的完整旅程

以创建 Skill（`POST /v1/skills`）为例：

1. `index.ts` 接到请求，request-id 与 auth 中间件先行，不通过则以 401 结束。
2. `lib/multipart.ts` 预检 `Content-Length` 后解析 formData，拆出文本字段（`display_title`，未知文本字段直接 400）与文件字段映射。
3. handler 把映射交给 `service.createSkill`。service 调 `@nano/shared` 的 `tree.ts` 归一化：路径校验、单根剥离、确认 `SKILL.md` 在根、上限裁决（任一超限 → 413）、计算哈希；再对 `SKILL.md` 的字节跑 `frontmatter.ts` 提取 `name` / `description`（缺失或非法 → 400）。
4. service 生成 `skill_` / `skv_` 两个 ID，调用 `createSkillWithFirstVersion`：Skill 行（`latest_version_seq = 1, next_version = 2`）、版本元数据行、分块的文件行，全部在一个 D1 batch 里。
5. `serialize.ts` 把返回的行转成 API JSON，handler 以 201 响应，`latest_version` 回显 `"1"`。

下载（`GET /v1/skills/{skillId}/versions/{version}/content`）是同一条链路的输出侧：service 校验版本存在（404）后，`listSkillFiles` 顺序读行，`zip.ts` 组装字节，handler 以 `application/zip` 响应并写入 `etag: "<content_sha256>"`。

## 测试策略

纯函数单测在 `packages/shared/test/skill/`，node 环境毫秒级：`tree.test.ts` 穷举路径非法形态（绝对路径、`..`、`\`、控制字符、`.git`、超长）、单根剥离的四种情形（有前缀 / 无前缀 / 前缀下无 SKILL.md / 多根）、上限边界、哈希对路径排序的确定性；`frontmatter.test.ts` 覆盖合法块、缺 `---` 闭合、缺键、name 非法字符、description 超长、多余键被忽略。

集成测试在 `apps/api/test/skills/`，真实 Workers 运行时 + miniflare D1，`helpers.ts` 提供 multipart body 构造工厂（用 `FormData` 直接拼）与错误信封断言。除九个端点的契约（创建回显、分页游标往返、404、409 并发、删除幂等语义、引用保护）外，两个专项：`download-skill-zip.test.ts` 用 fflate 的 `unzipSync` 解回字节，断言根目录形态、条目内容与确定性（两次下载字节一致）；删除保护的用例与 Agent 联动——先建 Agent 引用某版本，删版本 / 删 Skill 均须 400，解除引用（更新 Agent）后可删。Agent 侧引用存在性校验的回归用例补在 `apps/api/test/agents/`（引用不存在的 skill → 400）。

## 对样板的偏离点

与 Agent 模块逐条对照，Skill 模块的形态差异只有三处，其余全部照抄：

| 偏离 | Agent | Skill | 根因 |
| --- | --- | --- | --- |
| 请求编码 | JSON（`lib/body.ts`） | multipart（`lib/multipart.ts`） | 资源主体是文件目录，不是结构化配置 |
| 存储形态 | 配置进 JSON 列，两张表 | 内容进 BLOB 行，三张表 | 目录树无法压进单个 JSON 列（尺寸与透明度） |
| 终止操作 | 归档（幂等 UPDATE） | 硬删除（级联 batch） | GLM 语义；引用检查兜底一致性 |

## 演进预留

- **R2 内容桶**：单文件或总量上限不够用时，`skill_files` 换成 `R2 skills/{skill_id}/{version}/**`，D1 只留元数据；写入顺序改为「先 R2 后 D1 事务」，失败时按前缀清理孤儿对象。repo 接口不变，改动收敛在存储层。
- **`zai` 内置 Skill**：GLM 有平台内置 Skill（`source: "zai"`，Agent 引用 `type: "zai"`）。引入时给 `skills.source` 放开枚举、在种子迁移里插入内置行即可，端点与引用校验无需改形状。
- **引用关系物化**：删除保护的 `json_each` 扫描在数据量大了之后会成为瓶颈。届时加一张 `agent_skill_refs(agent_id, agent_version, skill_id, skill_version)` 物化表，由 Agent 写入路径同步维护，查询改点查。
- **Skill 元数据更新**：GLM 当前没有更新 `display_title` 的端点；若需要，补 `POST /v1/skills/{skillId}` 即可，表结构已经支持（Skill 级字段）。
