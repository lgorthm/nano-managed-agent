# Skill 表结构设计

依据 GLM Managed Agents 的 Skill 资源模型（见 `references/api/create-skill.md`、`references/api/create-skill-version.md` 等九份接口参考）设计，
落库于 D1（SQLite），通过 Drizzle 定义在 `packages/db/src/schema.ts`。
Skill 模块沿用 [Agent 表结构设计](../agent/schema.md) 的版本化思路，新增的问题是：**资源的主体不是配置 JSON，而是一棵文件目录树**。

## 设计原则

1. **与 API wire-format 一一对应**：GLM 的 Skill 响应字段（`id` / `type` / `display_title` / `source` / `latest_version` / `created_at` / `updated_at`）与 SkillVersion 响应字段（`id` / `type` / `skill_id` / `version` / `name` / `description` / `directory` / `created_at`）都能直接从表中读出；`version` 在 wire 上是字符串，库内存整数（见「约定」）。
2. **版本不可变**：每次上传完整目录生成一个新的不可变快照版本；「最新版本」只是 Skill 级的一个指针。`name` / `description` / `directory` 这些版本元数据从 `SKILL.md` 的 frontmatter 解析后随版本快照落库，读取时零加工。
3. **落库即归一化**：上传的 multipart 字段名是 Skill 内相对路径，允许整体多包一层顶层目录。写入前统一剥离单根前缀、校验路径合法性、解析 frontmatter，使 `skill_files` 存的是规范树（canonical tree），下载 ZIP 时按同一棵树确定性重建。
4. **Skill 级与版本级分离**：`display_title` / `source` / `latest_version` 指针是 Skill 级字段；每个版本自带 `created_at` 与不可变的文件树。GLM 没有 Skill 元数据更新端点，`display_title` 只在创建时设置。
5. **内容与元数据同库**：文件内容以 BLOB 行存进 D1，与版本元数据在同一个 D1 batch（隐式事务）里写入——「版本可见 ⇔ 文件完整」，不存在元数据先落库、内容上传失败的中间态。这是内容进 D1 而不是 R2 的核心理由；上限约束（见「校验规则」）保证不越出 D1 的行尺寸与请求体预算。大二进制资产是明确的演进预留。

## 表结构

### `skills` — Skill 级状态

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Skill ID，`skill_` + 小写 UUIDv7（与 `agent_` 形态一致） |
| `display_title` | TEXT | NULL, ≤ 256 | 可选展示名；仅创建时可设置（GLM 无更新端点） |
| `source` | TEXT | NOT NULL, default `'custom'` | 来源；nano 单租户无平台内置 Skill，恒为 `custom`，保留列是为了 wire-format 一致 |
| `latest_version_seq` | INTEGER | NULL | 最新版本的整数序号，指向 `skill_versions(skill_id, version)`；NULL 表示空壳（所有版本已删，仍可继续上传新版本） |
| `next_version` | INTEGER | NOT NULL | 下一个待分配的版本号，从 1 起、单调递增、**删除后不复用**；并发分配的 CAS 依据 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 创建时间（= 版本 1 的 `created_at`），列表排序键 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 冗余最新版本的 `created_at`（或指针变动时间），避免列表 JOIN |

索引：

- `idx_skills_created_at_id (created_at, id)` — `GET /v1/skills` 默认按创建时间倒序，keyset 游标分页。

### `skill_versions` — 不可变目录快照（元数据）

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `skill_id` | TEXT | NOT NULL, FK → `skills.id` | 所属 Skill |
| `version` | INTEGER | NOT NULL, ≥ 1 | 版本号（wire 上渲染为字符串 `"1"`、`"2"`…） |
| `id` | TEXT | NOT NULL, UNIQUE | SkillVersion ID，`skv_` + 小写 UUIDv7；版本寻址一律用 `(skill_id, version)`，此列用于响应回显 |
| `name` | TEXT | NOT NULL | 从 `SKILL.md` frontmatter 解析的 `name`（`^[a-z0-9][a-z0-9-]{0,63}$`） |
| `description` | TEXT | NOT NULL, 1–1024 | 从 frontmatter 解析的 `description` |
| `directory` | TEXT | NOT NULL | 目录名：上传带单根前缀时为该前缀名，否则等于 frontmatter `name`；下载 ZIP 以它为根目录 |
| `file_count` | INTEGER | NOT NULL | 文件数（含 `SKILL.md`），校验上限 ≤ 256 |
| `total_bytes` | INTEGER | NOT NULL | 全部文件字节数，校验上限 ≤ 20 MiB |
| `content_sha256` | TEXT | NOT NULL | 规范树哈希（见下），用于下载 ETag 与日志对照；**不**用于去重 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 版本生成时间；同时作为 ZIP 条目的固定 mtime |

主键：`(skill_id, version)`，天然覆盖「取最新版本」（经 `latest_version_seq` 点查）与「列出版本」（按 `version` 范围扫描）两类查询。`id` 上建唯一索引。

### `skill_files` — 不可变目录快照（内容）

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `skill_id` | TEXT | NOT NULL, FK → `skills.id` | 所属 Skill |
| `version` | INTEGER | NOT NULL | 所属版本，与 `skill_versions` 同生共死 |
| `path` | TEXT | NOT NULL | 规范树内的相对路径（已剥离单根前缀），如 `SKILL.md`、`scripts/run.py`；`/` 分隔、区分大小写 |
| `content` | BLOB | NOT NULL, ≤ 1 MiB | 文件原始字节；D1 绑定参数原生接受 `Uint8Array` |
| `size` | INTEGER | NOT NULL | 字节数 |
| `sha256` | TEXT | NOT NULL | 单文件哈希，供完整性校验与规范树哈希计算 |

主键：`(skill_id, version, path)`。复合主键在 `(skill_id, version)` 相等前缀下按 `path` 有序，下载 ZIP 直接顺序读出即天然按路径排序，无需额外索引。

### 为什么内容进 D1 而不是 R2

R2 方案（每版本存一个 zip 对象）解除了大小限制，但要自己处理「元数据事务成功、R2 写入失败」的孤儿对象与反方向的悬挂引用，下载也多一跳。nano 一期的取舍：

- Skill 目录以文本为主（`SKILL.md`、脚本、参考文档），上限内单文件 ≤ 1 MiB、总量 ≤ 20 MiB，D1 完全承载得住；
- 版本 + 文件在一个 batch 里原子写入，复用 Agent 模块已经成立的「D1 batch 是隐式事务」纪律，不引入第二种存储的事务协调；
- 下载 ZIP 在 Worker 内存里现场组装（fflate），20 MiB 上限远低于 Workers 内存预算。

超过上述上限的 Skill（例如内嵌大二进制资产）出现时，再按「演进预留」迁往 R2。

## 规范树（归一化形态）

上传进入服务端后、落库前，目录树被归一化为唯一形态；`skill_files` 存的就是这棵树：

- **路径**：必须是相对路径，`/` 分隔；总长 ≤ 256 字符、路径段数 ≤ 16、单段 ≤ 128 字符。拒绝：绝对路径、含 `..` 段、含 `\`、含 NUL 或其他控制字符、以 `.git/` 开头或等于 `.git` 的路径。
- **单根剥离**：若所有字段名共享同一个顶层目录前缀且 `SKILL.md` 位于其中（如 `pdf-tools/SKILL.md`、`pdf-tools/scripts/x.py`），归一化时剥离该前缀；否则要求 `SKILL.md` 直接位于顶层。`directory` 记录被剥离的前缀名，无前缀时取 frontmatter `name`。
- **`SKILL.md` 强制在根**：归一化后的树必须包含精确大写的 `SKILL.md`（路径区分大小写）。
- **frontmatter**：`SKILL.md` 必须以 YAML frontmatter 块（`---` 围起）开始，其中 `name` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`、`description` 长度 1–1024。其余键（如 `allowed-tools`）原样保留在文件内容里，不提取、不校验。
- **规范树哈希**：对 `(path, sha256(content))` 按 path 字典序排列后逐行拼接 `"{path}\0{sha256}\n"` 计算 SHA-256。同一目录内容的重复上传得到相同哈希——但 nano **不做无变化去重**（GLM 未定义该语义），每次上传都生成新版本；哈希仅用于下载 ETag 与日志。

## 关键读写流程

### 创建（`POST /v1/skills`）

```
batch:
  1. INSERT INTO skills (id, source='custom', display_title, latest_version_seq=1, next_version=2, …)
  2. INSERT INTO skill_versions (skill_id, version=1, id=skv_…, name, description, directory, …)
  3. INSERT INTO skill_files …   -- 分块 multi-row INSERT,每块 ≤ 50 行(见「风险」)
```

Skill 行、版本元数据行、全部文件行要么都写入，要么都不生效。

### 创建版本（`POST /v1/skills/{skillId}/versions`）

1. 读 Skill 行，不存在 → 404。
2. 以 `next_version` 为期望版本号，**两阶段认领**：

```sql
-- 阶段一:认领版本号。0 行受影响 → 并发上传抢号 → 409,一个字节都不写
UPDATE skills
   SET next_version = :expectedNext + 1
 WHERE id = :skillId
   AND next_version = :expectedNext;
```

```sql
-- 阶段二(认领成功后,一个 D1 batch):写入版本行与文件行,并前移最新版本指针。
-- 批内任何 SQL 错误整体回滚;最坏结果是版本号留一个空洞(分配器只增不减,语义安全)
UPDATE skills
   SET latest_version_seq = :expectedNext,
       updated_at         = :now
 WHERE id = :skillId;
```

为什么不能「先插入、后 CAS」一步到位：D1 batch 只对 SQL **错误**回滚，对「UPDATE 影响 0 行」照样提交——抢号失败时先写入的文件行会成为孤儿。两阶段认领把守卫变成第一条独立语句，失败即返回。与 Agent 更新的 CAS 目的相同：冲突说明期间有其他上传改过 `next_version`，客户端重试即可。版本号删除后不复用（`next_version` 只增不减），保证「同一 skill 下版本号唯一定位一个历史快照」永远成立。

### 删除版本（`DELETE /v1/skills/{skillId}/versions/{version}`）

先做引用检查（见下），未被引用则在一个 batch 里：

```
1. DELETE FROM skill_files   WHERE skill_id = ? AND version = ?
2. DELETE FROM skill_versions WHERE skill_id = ? AND version = ?
3. UPDATE skills
      SET latest_version_seq = (SELECT MAX(version) FROM skill_versions WHERE skill_id = ?),
          updated_at = :now
    WHERE id = :skillId
```

batch 内语句顺序执行，步骤 3 的子查询已看不到被删的版本行：删的是最新版本时指针自动落到剩余最大版本，没有剩余时为 NULL（空壳 Skill）。空壳仍可再上传新版本，版本号从 `next_version` 继续递增。

### 删除 Skill（`DELETE /v1/skills/{skillId}`）

引用检查通过后级联三删，一个 batch：

```
1. DELETE FROM skill_files    WHERE skill_id = ?
2. DELETE FROM skill_versions WHERE skill_id = ?
3. DELETE FROM skills         WHERE id = ?
```

与 Agent 的「无删除、归档即终止」不同，Skill 的终止操作就是硬删除——GLM 语义如此，且 Skill 没有「历史可回放」的合规负担，引用检查替它兜住了一致性。

### 引用检查（删除保护与 Agent 侧存在性校验）

Agent 配置通过 `{type, skill_id, version}` 引用固定版本的 Skill（见 [Agent schema](../agent/schema.md) 的 `skills` 列）。两个方向都落在这套表上：

- **删除保护**：被**活动配置**引用的 Skill / SkillVersion 不可删除——活动配置指未归档 Agent 的**当前版本快照**（GLM「被活动配置引用」的落地）。历史版本快照中的引用不阻止删除：它们只是不可变的配置记录，不再被新的会话使用；这样「更新 Agent 解除引用、或归档 Agent 后即可删除」的路径才真正可达。查询用 D1 内建的 JSON1 函数，单租户小数据量下全表扫描可接受：

```sql
SELECT EXISTS (
  SELECT 1
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
                 AND a.current_version = av.version
                 AND a.archived_at IS NULL,
         json_each(av.skills) AS ref
   WHERE json_extract(ref.value, '$.skill_id') = :skillId
     AND json_extract(ref.value, '$.version')  = :versionStr  -- 删单个版本时增加此条件
) AS referenced;
```

- **Agent 侧存在性校验**（Agent 创建/更新时的增量）：请求里的 `skills[]`（≤ 20 项）去重后逐个点查 `skill_versions` 的主键，全部命中才放行；`type: "zai"` 因 nano 无平台内置 Skill 一律拒绝。这是 Agent 模块上线 Skills 后补的闭环，见 [work-plan](work-plan.md) M8。

## 校验规则（服务层；DB 只保留基本约束）

| 规则 | 来源 |
| --- | --- |
| multipart 含 `SKILL.md`（归一化后在根） | GLM：上传内容必须包含顶层目录中的 `SKILL.md` |
| frontmatter `name` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；`description` 1–1024 | Agent Skills 约定 |
| 路径合法（相对、长度/段数上限、无 `..` / `\` / 控制字符 / `.git`）；路径不重复 | 目录形态 |
| 文件数 ≤ 256（含 `SKILL.md`）；单文件 ≤ 1 MiB；总量 ≤ 20 MiB | D1 行尺寸与 Worker 内存预算 |
| 文本字段仅允许 `display_title`（≤ 256，仅创建）；未知文本字段拒绝 | 上传形态 |
| `version` 路径参数匹配 `^[1-9][0-9]{0,9}$` | 寻址形态 |
| Agent 引用 `(skill_id, version)` 必须存在于 `skill_versions`；`type` 仅 `custom` | 引用一致性 |

超上传上限（文件数 / 单文件 / 总量）返回 `413 request_too_large`，其余校验失败返回 400。

## Drizzle 定义（落地到 `packages/db/src/schema.ts`）

```ts
import { customType } from "drizzle-orm/sqlite-core";

/** BLOB ↔ Uint8Array:D1 绑定参数原生接受 Uint8Array */
const blob = () =>
  customType<{ data: Uint8Array; driverData: ArrayBuffer }>({
    dataType: () => "blob",
    toDriver: (v) => v,
    fromDriver: (v) => new Uint8Array(v),
  });

/** Skill 级状态:身份、展示名、最新版本指针、版本号分配器 */
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(), // skill_ + UUIDv7
    displayTitle: text("display_title"),
    source: text("source").notNull().default("custom"),
    latestVersionSeq: integer("latest_version_seq"),
    nextVersion: integer("next_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_skills_created_at_id").on(t.createdAt, t.id)],
);

/** 版本级目录快照(元数据):frontmatter 解析结果与统计;写入后不可变 */
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    id: text("id").notNull(), // skv_ + UUIDv7
    name: text("name").notNull(),
    description: text("description").notNull(),
    directory: text("directory").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.version] }),
    uniqueIndex("idx_skill_versions_id").on(t.id),
  ],
);

/** 版本级目录快照(内容):规范树,与版本行同 batch 写入、同 batch 删除 */
export const skillFiles = sqliteTable(
  "skill_files",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    path: text("path").notNull(),
    content: blob()("content").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.version, t.path] })],
);
```

## 约定

- **时间戳**：DB 存 `timestamp_ms` 整数；API 输出 ISO 8601 UTC（`2026-09-01T02:00:00.000Z`）。
- **`type` 固定字段**：`type: "skill"` / `type: "skill_version"` / 删除回执的 `skill_deleted` / `skill_version_deleted` 均不落库，序列化时注入。
- **版本号在边界处转写**：库内整数（`version` 列、游标、排序），wire 上字符串（`latest_version`、`version` 字段、路径参数）。GLM 的版本是不透明 string，nano 用「单调递增整数的十进制字符串」填充同一形状，从而有序、可寻址、可 CAS。
- **删除响应**：GLM 返回 200 + `{id, type}` 回执而非 204，nano 保持一致。
- **无变化不去重**：同一目录重复上传仍生成新版本；`content_sha256` 只服务下载 ETag（`ETag: "<content_sha256>"`）与日志。
- **ZIP 确定性**：下载的 ZIP 以 `<directory>/` 为唯一根，条目按 path 字典序、mtime 恒为版本 `created_at`，同一版本的任意两次下载字节一致，ETag 因此稳定。
- **分页游标**：Skill 列表按 `(created_at, id)` keyset，版本列表按 `version` keyset，游标经 `lib/pagination.ts` 的 kind 前缀防混用（`skills` / `skill-versions`）。
