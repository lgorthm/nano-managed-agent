# Skill 模块实现计划

本计划依据 [structure.md](structure.md) 定下的结构与 [schema.md](schema.md) 的表设计，把 Skill 模块的实现拆成十个里程碑：一个地基阶段、八个按接口竖切的阶段、一个收尾阶段。与 [Agent 实现计划](../agent/work-plan.md) 同一思路——做完一个里程碑，对应接口即处于可交付状态，验收就是拿接口文档逐条对照行为。

## 总体思路

**按接口竖切，骨架先行。** M1（创建 Skill）是第一片竖切，负责把 `modules/skill` 的骨架立起来；后续端点照抄骨架填各自语义。Skill 的端点数比 Agent 多（九个），但读取类与删除类的实现极薄，因此把互相独立的端点按形态归组进同一里程碑（M2 读取 Skill、M4 版本读取），每个里程碑仍以「对应文档全部可验收」为完成线。

**纯函数先行、测试穷举。** 规范树与 frontmatter 是 Skill 语义里最容易出错的部分（路径穿越、大小写、单根剥离、frontmatter 边界），M0 就把 `@nano/shared` 的三个文件连同 node 单测全部做完，进入 Workers 集成测试之前先把语义钉死。

**删除与联动放最后。** 删除保护依赖「Agent 引用 Skill」的测试数据，Agent 侧存在性校验又依赖 Skill 的读取端点，所以两个删除里程碑放在全部读写端点之后，Agent 联动（M8）放在最后，收尾验收（M9）覆盖全链路。

## 里程碑总览

| 里程碑 | 交付能力 | 对应接口文档 | 规模 |
| --- | --- | --- | --- |
| M0 地基 | 三张表与迁移就绪，规范树 / frontmatter 纯函数与单测就绪，multipart 横切设施就绪 | — | 大 |
| M1 创建 | `POST /v1/skills` | [create-skill.md](api/create-skill.md) | 大 |
| M2 读取 Skill | `GET /v1/skills/{skillId}`、`GET /v1/skills` | [get-skill.md](api/get-skill.md)、[list-skills.md](api/list-skills.md) | 小 |
| M3 创建版本 | `POST /v1/skills/{skillId}/versions` | [create-skill-version.md](api/create-skill-version.md) | 中 |
| M4 版本读取 | `GET /v1/skills/{skillId}/versions/{version}`、`GET /v1/skills/{skillId}/versions` | [get-skill-version.md](api/get-skill-version.md)、[list-skill-versions.md](api/list-skill-versions.md) | 小 |
| M5 下载 | `GET /v1/skills/{skillId}/versions/{version}/content` | [download-skill-zip.md](api/download-skill-zip.md) | 中 |
| M6 删除版本 | `DELETE /v1/skills/{skillId}/versions/{version}` | [delete-skill-version.md](api/delete-skill-version.md) | 中 |
| M7 删除 Skill | `DELETE /v1/skills/{skillId}` | [delete-skill.md](api/delete-skill.md) | 小 |
| M8 Agent 联动 | Agent 创建 / 更新校验 Skill 引用存在性 | —（改动 [Agent API](../agent/api/README.md) 行为） | 中 |
| M9 收尾 | 全量验收，接口行为与文档逐条核对 | 全部 | 小 |

依赖关系：M2、M4 是纯读取，只依赖 M1；M3 只依赖 M1；M5 依赖 M4（要先能寻址版本）；M6 依赖 M3（多版本测试数据）；M7 依赖 M6（复用引用检查与级联删除的夹具）；M8 依赖 M4；M9 最后。

```
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9
```

## 通用工作约定

以下约定适用于每个里程碑，后文不再重复：

- **完成定义（DoD）**：`pnpm typecheck` 与 `pnpm test` 全绿；本里程碑新增测试全部通过；接口行为对照对应文档的「错误行为」表和请求 / 响应示例逐条核对过；`pnpm dev` 起本地服务后用 curl 冒烟通过。
- **提交粒度**：一个里程碑至少一个提交；M0、M1 建议按 shared → db → api 分成三个提交，便于回溯。
- **迁移纪律**：凡是改了 `packages/db/src/schema.ts`，必须紧接着运行 `pnpm db:generate` 生成迁移并提交。
- **测试先行部分**：涉及 `@nano/shared` 纯函数的任务，先写单测用例清单再写实现。

---

## M0 地基

不产出业务端点。结束时表已建好、上传解析与规范树规则已钉死，后续竖切不需要再为基础设施分心。

**存储层：**

- [x] 在 `packages/db/src/schema.ts` 中按 [schema.md](schema.md#drizzle-定义落地到-packagesdbsrctschemats) 追加 `skills` / `skill_versions` / `skill_files` 三张表（含 `idx_skills_created_at_id`、`idx_skill_versions_id` 与三组复合主键）。
- [x] 运行 `pnpm db:generate` 生成迁移，`pnpm db:migrate:local` 本地跑通；用 sqlite 客户端确认 BLOB 列与索引按预期创建。

**协议层（含单测，本里程碑的主体）：**

- [x] 新建 `packages/shared/src/skill/tree.ts`：实现路径校验、单根剥离、`SKILL.md` 在根检查、文件数 / 单文件 / 总量上限裁决、逐文件 SHA-256 与规范树哈希；导出上限常量（`MAX_FILES`、`MAX_FILE_BYTES`、`MAX_TOTAL_BYTES`、`MAX_PATH_LENGTH` 等）。
- [x] 新建 `packages/shared/src/skill/frontmatter.ts`：实现 `SKILL.md` frontmatter 提取与 `name` / `description` 校验，多余键忽略。
- [x] 新建 `packages/shared/src/skill/schemas.ts`：`SkillResponse` / `SkillVersionResponse` / 删除回执类型（`SkillReference` 复用 `agent/schemas.ts`）。
- [x] 单测 `tree.test.ts`：穷举路径非法形态（绝对路径、`..` 段、反斜杠、控制字符、`.git`、超长、段数超限）；单根剥离四种情形（有前缀 / 无前缀 / 前缀下无 SKILL.md / 多根）；上限边界（恰好等于 / 超过）；重复路径；哈希对 (path, sha256) 排序的确定性（打乱输入顺序结果不变）。
- [x] 单测 `frontmatter.test.ts`：合法块、缺起始 `---`、未闭合、缺 `name` / `description`、name 非法字符与超长、description 超长、多余键被忽略、CRLF 行尾。

**传输层：**

- [x] 新建 `apps/api/src/lib/multipart.ts`：包装 `request.formData()`，拆分文本字段与文件字段（字段名即路径，忽略 `File.name`）；`Content-Length` 预检 + 解析后按实际字节数复核总量上限，超限抛 `request_too_large`；content-type 非法或解析失败转 `invalid_request_error`。
- [x] `apps/api` 添加 `fflate` 依赖（M5 才会用到，先行入列避免后续改 lockfile）。

**验收：**

- [x] `pnpm typecheck`、`pnpm test` 全绿（shared 新增单测全数通过）。
- [x] 本地 D1 中能看到三张新表，既有 agents 迁移不受影响。

---

## M1 创建 Skill — `POST /v1/skills`

第一片竖切，立起 `modules/skill` 骨架：routes、service、serialize、handlers 目录在里程碑结束时成形。

**存储层：**

- [x] 新建 `packages/db/src/skill/ids.ts`：`newSkillId()`（`skill_` + UUIDv7）与 `newSkillVersionId()`（`skv_` + UUIDv7）。
- [x] 新建 `packages/db/src/skill/repo.ts`：实现 `createSkillWithFirstVersion`——Skill 行（`latest_version_seq = 1, next_version = 2`）、版本元数据行、文件行（分块 multi-row INSERT，每块 ≤ 50 行）放进同一个 D1 batch。

**传输层：**

- [x] 建立 `apps/api/src/modules/skill/` 骨架：`routes.ts`（声明 `POST /v1/skills`）、`serialize.ts`（Skill 行 / 版本行转 API JSON：时间戳转 ISO、注入 `type`、`latest_version_seq` 转 `"1"` 形态）、`service.ts`（`createSkill`：multipart 解析 → `tree.ts` 归一化（超限 → 413，非法 → 400）→ `frontmatter.ts` 提取 → 生成 ID → 落库）、`handlers/create-skill.ts`。
- [x] 在 `routes/v1.ts` 挂载 `v1.route("/skills", skillRoutes)`。

**测试与验收：**

- [x] 集成测试 `create-skill.test.ts`：按文档「请求示例」原样创建（含 `display_title` 与两个文件），201 响应逐字段对照示例；`SKILL.md` 带单根前缀上传时 `directory` 回显前缀名、无前缀时等于 `name`；frontmatter 的 `name` / `description` 出现在首版本元数据中（用 M4 之前的临时手段或直查库断言）。
- [x] 错误路径：缺 `SKILL.md` 400；frontmatter 缺 `name` 400；name 含大写 400；路径含 `..` 400；未知文本字段 400；单文件超 1 MiB 413；总量超 20 MiB 413（构造大字段节数，可用最小必要体积）；不带凭证 401。
- [x] curl 冒烟：multipart 上传一个真实小目录，肉眼比对响应。

---

## M2 读取 Skill — `GET /v1/skills/{skillId}` 与 `GET /v1/skills`

在 M1 骨架上补两个只读端点，主要工作是两个 join-free 查询和分页接入。

- [x] `repo.ts` 新增 `findSkill(db, skillId)`（查不到返回 null）与 `listSkillsPage(db, {source, limit, order, cursor})`（按 `(created_at, id)` keyset，`source` 过滤直接下推到 `WHERE`）。
- [x] `service.ts` 新增 `getSkill`（null → 404）与 `listSkills`；新建 `handlers/get-skill.ts`、`handlers/list-skills.ts` 并注册路由。
- [x] 集成测试 `get-skill.test.ts`：创建后获取字段一致；不存在的 id 404 且是完整错误信封；不带凭证 401。
- [x] 集成测试 `list-skills.test.ts`：造 25 个 Skill，默认参数 20 条、按创建时间倒序、`next_page` 非空；携游标翻页取剩余 5 条；`limit=5` 生效；`limit=200` 截断为 100；`limit=0` 400；`order=asc` 正序；`source=custom` 全量、`source=zai` 空页；篡改游标 400。

**验收**：分页行为逐条对照 [list-skills.md](api/list-skills.md) 与 [api/README.md](api/README.md#分页)；游标 kind 前缀为 `skills`，把 agents 游标传入必须 400。

---

## M3 创建 Skill Version — `POST /v1/skills/{skillId}/versions`

并发语义在本里程碑落地：版本号分配器的 CAS。

- [x] `repo.ts` 新增 `insertNextSkillVersionAndAdvance(db, {skillId, expectedVersion, versionId, meta, tree, now})`：**两阶段认领**——先以 `WHERE id = ? AND next_version = ?` 单独 CAS 认领版本号（0 行受影响返回 false），认领成功后一个 batch 写入版本行与文件行并前移 `latest_version_seq`。实现时发现不能合并成「先插入、后 CAS」的单 batch：D1 batch 只对 SQL 错误回滚，对 0 行 UPDATE 照样提交，会留孤儿文件行（仓库函数命名加 `Skill` 前缀，与 agent repo 同语义函数在 `@nano/db` 汇总导出时避免同名冲突）。
- [x] `service.ts` 新增 `createSkillVersion`：Skill 不存在 → 404；multipart 携带文本字段 → 400（校验放在归一化之前，报错信息指向字段名）；归一化与 frontmatter 同 M1；CAS 失败 → 409。
- [x] 新建 `handlers/create-skill-version.ts` 并注册路由。
- [x] 集成测试 `create-skill-version.test.ts`：对已有 Skill 上传两次，版本号 `"2"`、`"3"` 递增、`getSkill` 的 `latest_version` 前移；frontmatter 变化体现在新版本元数据；重复上传相同内容也生成新版本（不去重）；空壳 Skill（M6 之前用直改库制造）上传后版本号继续递增不复用；409 用「先取 `next_version`，绕过接口直改库推高，再以旧值调上传」模拟；不存在的 Skill 404。
- [x] curl 冒烟：按文档示例走一遍带两个脚本文件的版本上传。

---

## M4 版本读取 — `GET /v1/skills/{skillId}/versions/{version}` 与 `GET /v1/skills/{skillId}/versions`

- [x] `repo.ts` 新增 `findSkillVersion(db, skillId, version)` 与 `listSkillVersionsPage(db, skillId, {limit, order, cursor})`（按 `version` 数字序 keyset）。
- [x] `service.ts` 新增 `getSkillVersion`（Skill 不存在与版本不存在同返回 404；`version` 不匹配 `^[1-9][0-9]{0,9}$` → 400）与 `listSkillVersions`；新建 `handlers/get-skill-version.ts`、`handlers/list-skill-versions.ts`。
- [x] 序列化注意：`version` 整数转字符串、`type: "skill_version"` 注入、`skill_id` 回显。
- [x] 集成测试 `get-skill-version.test.ts`：多版本 Skill 逐版本读取，各版本 `name` / `description` / `directory` 与当时上传一致；`version=01` / `1a` 400；不存在的版本 404；不带凭证 401。
- [x] 集成测试 `list-skill-versions.test.ts`：三个版本默认倒序 `"3","2","1"`；`order=asc` 正序；游标翻页；把 `list-skills` 的游标传入 400；不存在的 Skill 404。

---

## M5 下载 ZIP — `GET /v1/skills/{skillId}/versions/{version}/content`

输出侧竖切：第一个（也是一期唯一的）二进制响应端点。

- [x] 新建 `apps/api/src/modules/skill/zip.ts`：读 `listSkillFiles(db, skillId, version)` 的按 path 有序行流，用 fflate 组装 ZIP——根目录一层 `<directory>/`、条目 mtime 恒为版本 `created_at`。
- [x] `repo.ts` 补 `listSkillFiles`；`service.ts` 补 `downloadSkillZip`（版本不存在 → 404）；新建 `handlers/download-skill-zip.ts`：以 `application/zip` 响应，附 `content-disposition: attachment; filename="<directory>-v<version>.zip"` 与 `etag: "<content_sha256>"`。
- [x] 集成测试 `download-skill-zip.test.ts`：用 fflate `unzipSync` 解回，断言根目录形态（`<directory>/SKILL.md`）、每个条目字节与上传一致、目录为空的中间目录不产生条目；同一版本两次下载字节完全一致（确定性）；ETag 等于落库哈希；不存在的版本 404；不带凭证 401。
- [x] curl 冒烟：`-o` 落盘后 `unzip -l` 检查结构。

---

## M6 删除 Skill Version — `DELETE /v1/skills/{skillId}/versions/{version}`

删除语义最重的里程碑：引用保护与指针重指。

**存储层（先行）：**

- [x] `repo.ts` 新增 `isSkillVersionReferenced(db, skillId, version)`：`agent_versions` join 未归档 `agents` 的当前版本后，`json_each` + `json_extract` 存在性查询（SQL 见 [schema.md](schema.md#引用检查删除保护与-agent-侧存在性校验)）。实现时把判定范围从「任何版本快照」收窄为**活动配置**——否则「更新解除引用后可删」永远不可达（历史快照不可变，引用删不掉）。
- [x] `repo.ts` 新增 `deleteSkillVersionAndRetarget(db, {skillId, version})`：一个 batch 内删文件行、删版本行、按 `MAX(version)` 子查询重指 `latest_version_seq`（无剩余则置 NULL）；版本行不存在时返回 false。

**传输层：**

- [x] `service.ts` 新增 `deleteSkillVersion`：Skill 不存在 / 版本不存在 → 404；被引用 → 400（错误信息指明引用的 `(skill_id, version)`）；成功返回 `{id: skv_…, type: "skill_version_deleted"}` 回执。
- [x] 新建 `handlers/delete-skill-version.ts` 并注册路由。

**测试与验收：**

- [x] 集成测试 `delete-skill-version.test.ts`：删非最新版本，`latest_version` 不变；删最新版本，指针落到剩余最大版本；删到只剩零个版本，`latest_version` 为 null 且 Skill 仍可获取（空壳）；空壳再上传，版本号从分配器当前值继续；被活动配置引用的版本删除 400，更新 Agent 解除引用后可删；**历史版本**快照中的引用不阻止删除（更新后旧引用仅存于历史快照，删除成功）；`version=01` 400；不存在的版本 404。
- [x] curl 冒烟：创建 → 引用 → 删除被拒 → 解除 → 删除成功，全程对照文档。

---

## M7 删除 Skill — `DELETE /v1/skills/{skillId}`

在 M6 的引用检查之上补整资源级联删除。

- [x] `repo.ts` 新增 `isSkillReferenced(db, skillId)`（按 `skill_id` 匹配，判定范围同 M6：活动配置）与 `deleteSkillCascade(db, skillId)`：三张表级联删，一个 batch。
- [x] `service.ts` 新增 `deleteSkill`：不存在 → 404；被引用 → 400；成功返回 `{id, type: "skill_deleted"}`。新建 `handlers/delete-skill.ts` 并注册路由。
- [x] 集成测试 `delete-skill.test.ts`：删除后 `GET` 该 Skill 404、版本列表 404、下载 404；被任意版本引用时 400、解除后可删；删除含多版本的 Skill 后库中三张表均无残留（helpers 直查断言）；重复删除 404。

---

## M8 Agent 联动 — Skill 引用存在性校验

不改 Skill 端点，改动收敛在 Agent 模块与服务层之间的闭环：`skills[]` 引用从「格式合法」升级为「必须可解析」。

- [x] `repo.ts` 新增 `findMissingSkillVersionPairs(db, refs)`：对去重后的引用逐个点查 `skill_versions` 主键，返回缺失集合。
- [x] `apps/api/src/modules/agent/service.ts`：`createAgent` 与 `updateAgent` 在归一化之后、落库之前调用上述函数；`skills` 非空且存在缺失引用 → 400（错误信息列出缺失的 `(skill_id, version)`）；`type: "zai"` 的引用直接 400（nano 无平台内置 Skill）。合并语义不变——`updateAgent` 未提交 `skills` 字段时不触发校验。
- [x] 回归测试补进 `apps/api/test/agents/`：创建时引用不存在的 skill → 400；引用存在 skill 的不存在版本 → 400；引用 `type: "zai"` → 400；合法引用（先建 Skill 再建 Agent）→ 201；更新 Agent 提交 `skills: []` 清空后，M6/M7 的删除保护随之解除（与 `delete-skill-version.test.ts` 的既有用例互为闭环）。
- [x] 文档同步：在 [docs/agent/schema.md](../agent/schema.md) 的校验规则表中补上这一条来源为「引用一致性」的规则（小改动，单独提交）。

---

## M9 收尾与验收

- [x] 对照九份接口文档做一次系统核对：每个端点的响应字段与 OpenAPI 的 required 列表一致；`type` 固定字段在所有响应中恒定；错误信封在所有非 2xx 中格式一致且带 `request_id`；413 只出现在两个上传端点。
- [x] 用 curl 按真实顺序走一遍生命周期：创建 → 获取 → 列表 → 上传新版本 → 列版本 → 下载 ZIP → 建 Agent 引用 → 删版本被拒 → 更新 Agent 解除引用 → 删版本 → 删 Skill，全程对照文档示例。
- [x] 全量 `pnpm test` 与 `pnpm typecheck`；确认迁移在全新本地库上从零应用成功（agents + skills 全部迁移）。
- [x] 复查依赖规则未被违反：`modules/skill` 与 `modules/agent` 无横向 import（Agent 联动走 `@nano/db`）；`@nano/shared` 新增文件零内部依赖；`skill/repo.ts` 读 `agent_versions` 属于 db 层内部表组织，符合 structure.md 的约定。
- [x] 并发与确定性抽查：同一 Skill 并发两次上传只成功一次（或一胜一 409）；同一版本两次下载字节一致。

---

## 风险与注意事项

以下几处是实现时最可能踩坑的地方，提前列出：

- **D1 batch 的语句数与绑定参数上限**：256 个文件的请求若逐条 INSERT 会产生数百条语句。文件行必须分块为 multi-row INSERT（每块 ≤ 50 行、每行 6 个绑定参数），全部放进同一个 batch——既原子又不触碰限制。
- **multipart 解析的内存时序**：`request.formData()` 会把整个请求体读进内存，上限裁决必须先于解析按 `Content-Length` 预检一次，解析后再按实际字节数复核；跳过预检的话，恶意大请求会先吃满内存再被拒。
- **字段名与文件名是两回事**：路径取自 multipart 字段名；`File.name` 是客户端本地文件名，参与校验会造成同一目录在不同机器上传结果不同，必须忽略。
- **单根剥离的边界**：只有「所有路径共享同一前缀且 `SKILL.md` 位于该前缀下」才剥离；`a/SKILL.md` + `b/x.py` 是双根，`SKILL.md` + `a/SKILL.md` 是重名，都要 400 而不是静默取舍。`SKILL.md` 精确匹配大写，路径区分大小写。
- **引用检查是全表扫描**：`json_each` 查询无法走索引，单租户小数据量可接受；不要试图给 JSON 列加索引绕过，数据量真正上来时按 structure.md 的演进预留物化引用表。
- **指针重指必须在删除的同一个 batch 里**：先删版本行、再在同 batch 里跑 `MAX(version)` 子查询的 UPDATE。拆成两次调用会出现「版本已删、指针悬空」的窗口。
- **409 与 400 的分界**：版本号 CAS 失败（`next_version` 不匹配）是 409；被 Agent 引用、上传形态非法是 400；两者都会让写入不发生，但客户端的处置完全不同（重试 vs 改请求）。
- **ZIP 时间戳**：组装时若不固定 mtime，同一版本每次下载字节都不同，ETag 与缓存全部失效；条目 mtime 必须取版本 `created_at`，条目顺序必须按 path 字典序。
