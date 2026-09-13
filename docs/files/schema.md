# File 表结构设计

依据 GLM Managed Agents 的 File 资源模型（见 `references/api/upload-file.md`、`list-files.md`、`get-file.md`、`download-file.md`、`delete-file.md` 五份接口参考）设计。与前两个资源模块不同，File 的主体不是配置 JSON 或文本目录树，而是**单个大二进制对象**：元数据落库 D1（SQLite，Drizzle 定义在 `packages/db/src/schema.ts`），内容存 R2（`apps/api/wrangler.jsonc` 中预留的 `FILES` 绑定）。接口定义见 [api/](api/)。

## 设计原则

1. **与 API wire-format 一一对应**：GLM 的 File 响应字段（`type` / `id` / `size_bytes` / `created_at` / `filename` / `mime_type` / `downloadable`）都能直接从表中读出，序列化时零拼装。`scope` 在 GLM schema 中本就可选，nano 一期没有 Session 资源、不输出该字段（见「与 Session 的联动（预留）」）。
2. **元数据与内容分离**：D1 行是唯一权威元数据，R2 只存字节。对象键由 id 确定性派生（恒为 `files/{fileId}`），不落库、不参与 API。
3. **元数据在 ⇒ 内容可读**：上传先写 R2 再插 D1（插入失败时补偿删除 R2 对象），删除先删 D1 行再尽力清 R2。两个顺序共同保证下载路径不会出现「元数据存在而内容缺失」；反方向的中间态（R2 孤儿对象）只浪费存储、不影响正确性。
4. **不可变资源**：File 没有更新端点，上传即定格；删除是唯一生命周期变更。无版本、无归档、无指针，一行就是一个资源的全部状态——这也是单表即可的原因（对照 [Agent](../agent/schema.md) 的两张表、[Skill](../skills/schema.md) 的三张表）。会话产出是唯一例外形态：产出内容变化时收割编目**换新行新对象**（`session_outputs` 映射行就地改指，见「会话产出文件」），File 行本身仍然一经写入不再变。
5. **上传缓冲、下载流式**：上传经 `request.formData()` 整体缓冲后校验尺寸，因此单文件上限取 50 MiB——同时低于 Workers 请求体上限与 128 MB 内存预算的保守值；下载把 R2 返回的 `ReadableStream` 直接透传为响应体，Worker 不全量缓冲，上传上限不构成下载瓶颈。

## 为什么内容放 R2 而不是 D1 BLOB

[Skill 模块](../skills/schema.md)把文件内容以 BLOB 行存进 D1，换来「版本可见 ⇔ 文件完整」的 batch 原子性——它的前提是上限约束（总量 ≤ 20 MiB、单文件 ≤ 1 MiB、≤ 256 个文件）足以保证不越出 D1 的行尺寸与请求体预算。File 不满足这个前提：

- 单文件上限 50 MiB，远超 D1 行尺寸的合理预算，也远超「解析 JSON + 校验」的轻量请求体路径；
- File 是单个不可变对象，只整体写入、整体读出，不存在 Skill 那种「逐文件路径寻址、按树重建」的访问模式，放 BLOB 表没有任何查询收益；
- R2 的流式读写与按量计费正对「大二进制、不可变、整体访问」的形态；元数据与内容的一致性改由写入/删除顺序保证（原则 3），代价只是「孤儿对象仅浪费存储」这一可接受的弱化。

## 表结构

### `files` — File 元数据（内容在 R2）

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | File ID，`file_` + 小写 UUIDv7（与 GLM 的 `file_0191xxxx-…` 形态一致） |
| `filename` | TEXT | NOT NULL, 1–256 字符 | 上传时的原始文件名，原样存储与回显 |
| `mime_type` | TEXT | NOT NULL, ≤ 128 字符 | 归一化后的 media type（取 part 的 Content-Type 并去参数） |
| `size_bytes` | INTEGER | NOT NULL, 1–52,428,800 | 内容字节数，与 R2 对象的 size 一致 |
| `etag` | TEXT | NOT NULL | R2 `put` 返回的对象 ETag；下载端点回显为响应头 `etag` |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 上传时间，列表排序键 |

索引：

- `idx_files_created_at_id (created_at, id)` — `GET /v1/files` 按 `(created_at, id)` keyset 分页（默认倒序，最新上传的在前）。

## 关键读写流程

### 上传（`POST /v1/files`）

```
1. 解析 multipart：唯一文件字段 file → (filename, contentType, bytes)
2. 服务层校验：filename 1–256 字符（否则 400）；size ≤ 50 MiB（否则 413）；mime_type 归一化
3. newFileId() 生成 id，确定对象键 files/{id}
4. FILES.put(files/{id}, bytes) → 记录返回的 etag
5. INSERT INTO files (...) —— 成功后「元数据在 ⇒ 内容可读」成立
6. 若第 5 步失败 → best-effort FILES.delete(files/{id})，抛 api_error
```

### 下载（`GET /v1/files/{fileId}/content`）

```
1. D1 按 id 点查 → 查不到返回 404
2. FILES.get(files/{id}) → 元数据在而对象缺属运维事故路径，返回 api_error
3. 200：content-type = mime_type，content-disposition = attachment，etag 回显；
   响应体 = R2 的 ReadableStream 直接透传
```

### 删除（`DELETE /v1/files/{fileId}`）

```
0. 引用检查：被未归档会话挂载（session_resources JOIN sessions）→ 400
1. DELETE FROM files WHERE id = ? → 受影响 0 行返回 404
2. best-effort FILES.delete(files/{id})
3. 返回 { id, type: "file_deleted" }
```

删除顺序与上传相反的理由：先删元数据，后续读写立即 404；第 2 步失败留下的孤儿对象不影响正确性（下载先查元数据）。反过来先删内容则会出现「元数据在而内容缺」。孤儿清理留作运维脚本（演进预留）。

## 与 Session 的联动（已生效）

GLM 中 File 是独立资源，通过 Session Resource 挂载进沙箱（`POST /v1/sessions/{sessionId}/resources`，`{type: "file", file_id, mount_path}`），且「已被引用」的 File 不可删除。Session 模块已落地（见 [../session/](../session/schema.md)），三处回填已全部生效：

- 挂载关系表 `session_resources` 归 session 模块（对齐 GLM 的归属：挂载端点在 `/v1/sessions/*` 下，不在 `/v1/files` 下）。
- `delete-file` 增加引用检查：被未归档 Session 挂载的 File 拒绝删除（参照 Skill 模块「活动配置引用即阻止」的先例，返回 400）。
- `list-files` 的 `scope_id` 过滤从「恒返回空页」变为真实过滤，File 响应补 `scope` 字段。

租户级行为：不带 `scope_id` 的列表不输出 `scope` 字段；带 `scope_id` 时返回该会话挂载的 File 并逐条回显 `scope: {type: "session", id}`。

## 会话产出文件（session-scoped File，已生效）

沙箱产出文件编目为 File 资源——「写入 `/mnt/session/outputs` 的东西，用户能从 `/v1/files` 拿到」：

### 编目映射表 `session_outputs`（D1，归 session 模块）

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `file_id` | TEXT | PK, FK → files.id | 当前代表的 File 行 |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | 产出会话 |
| `path` | TEXT | NOT NULL | outputs 目录下的相对路径（含文件名），UNIQUE(session_id, path) |
| `content_sha256` | TEXT | NOT NULL | 内容指纹，收割幂等的判断依据 |
| `created_at` / `updated_at` | INTEGER (ts_ms) | NOT NULL | 首编目 / 最近换代时间 |

索引：`uq_session_outputs_session_path (session_id, path)`、`idx_session_outputs_session (session_id, updated_at, file_id)`。

### 收割协议（runtime.md §4.5 物化协议的编目落地）

每个 turn 收尾，`harvestOutputs` 把沙箱 outputs 目录读成「相对路径 → 字节」快照，交给编目编排（`apps/api/src/runtime/tools/catalog.ts`）收敛，规则是**差集同步、以沙箱现状为准**：

- **新路径** → R2 `put(files/{newId})` 先行 → 同 batch 插 file 行 + 映射行（`filename` = 相对路径，`mime_type` 按扩展名推断，未知回退 octet-stream）。
- **内容变化**（sha-256 不同）→ 换新 `file_` id 新行新对象，映射行就地改指；旧 file 行同 batch 删除，旧 R2 对象尽力清。**File 不可变原则不变**——「更新」落地为换 id，upsert 的是映射关系。
- **内容未变** → 跳过（幂等：重复收割零写入，file id 稳定，下载链接不漂移）。
- **沙箱里消失** → 映射行与 file 行删除、R2 对象尽力清。安全性依据：物化协议保证「编目过的内容必已回填进沙箱」，列目录完整时差集即真实删除（agent 的 rm/mv 不留过期条目）。
- **越界跳过**：超过 `MAX_FILE_BYTES`（50 MiB）或 filename 超 256 字符的产出不编目（沙箱内仍可用），非法相对路径（绝对路径、`..` 段）跳过。

一致性沿用上传的顺序契约（原则 3）：先 R2 后 D1，D1 失败补偿删新对象；反向失败只留孤儿对象。冷启物化的 outputs 回填也从「R2 前缀 list」切换为「D1 查映射 → R2 get `files/{fileId}`」，与挂载文件同一键空间。

### wire 与生命周期语义

- `scope_id` 过滤 = **挂载 ∪ 产出**（同一 File 双来源只出现一次）；产出文件在**任何列表与 get-file** 都恒回显 `scope`（一对一归属），挂载文件维持「仅 scope_id 过滤时回显」。
- 删除门禁：属于未归档会话的产出拒删（400，与挂载同语义）；已归档会话的产出可删，删除连带清理映射行。
- 会话删除级联：`session_resources` + `session_outputs` + 对应 `files` 行同一 batch 删除（**产出的 File 生命周期从属于产出它的会话**，与挂载的「File 本体不删」相反），R2 对象随后尽力清。已知取舍：产出 File 被其他会话挂载时，源会话删除会留下悬空挂载——`session_resources.file_id` 是软引用，物化读取对缺失 file 有 null-continue 防御。
- `toolsRan` 不跨崩溃恢复快照：恢复路径直接 end_turn 时本轮跳过收割，编目在下一 turn 按同一规则收敛（幂等保证收敛）。
- 历史 R2 前缀 `sessions/{id}/outputs/` 已弃用（dev 数据，不迁移）。

## 校验规则（服务层，zod + multipart 解析；DB 只保留基本约束）

| 规则 | 结果 |
| --- | --- |
| 请求为 `multipart/form-data` 且恰好含一个文件字段 `file`；出现未知字段 | 违反则 400 |
| `filename` 1–256 字符（UTF-8），不得为空 | 违反则 400 |
| `mime_type` 取 `file` part 的 Content-Type 并去参数（如 `text/plain; charset=utf-8` → `text/plain`）；缺失或无法解析时为 `application/octet-stream`；≤ 128 字符 | — |
| `size_bytes` ∈ (0, 52,428,800]，即单文件 ≤ 50 MiB | 超限 413 `request_too_large` |
| `fileId` 对应的行不存在（含重复删除） | 404 |
| 该 File 被未归档会话挂载 | 400（已归档会话的挂载不阻止删除） |
| `limit` < 1、`order` 非法、`page` 游标无效、`scope_id` 非 `sess_` 前缀 | 400 |

## Drizzle 定义（落地到 `packages/db/src/schema.ts`）

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * File 元数据；内容存 R2（对象键恒为 files/{id}，由 id 派生不落库）。
 * 行存在 ⇔ 内容可读（由上传 / 删除顺序保证）。
 */
export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(), // file_ + UUIDv7
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    etag: text("etag").notNull(), // R2 put 返回的对象 ETag，下载时回显
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_files_created_at_id").on(t.createdAt, t.id)],
);
```

实施提示：需在 `apps/api/wrangler.jsonc` 启用 R2 绑定（取消 `r2_buckets` 注释，binding 为 `FILES`），随后运行 `pnpm types` 重新生成 `worker-configuration.d.ts`，`env.FILES` 的类型即来自这里。

## 约定

- **时间戳**：DB 存 `timestamp_ms` 整数；API 输出 ISO 8601 UTC（`2026-09-11T08:00:00.000Z`）。
- **`type: "file"` 与 `downloadable: true`**：响应固定字段，不落库，序列化时注入（`downloadable` 在 nano 恒为 true，保留是为了 wire-format 一致；`scope` 一期不输出）。
- **上传成功状态码为 200**：与 GLM 的上传端点一致，注意与本库 create 类端点（Agent / Skill 的 201）不同。
- **R2 对象键**：恒 `files/{fileId}`，由 id 确定性派生、不落库；换桶或调整前缀时按此规则批量迁移。
- **分页游标**：按 `(created_at, id)` keyset，base64 编码后经 `next_page` 返回，payload 带类型前缀（`files:`）防止与其他列表端点的游标混用。
- **上限常量**：`MAX_FILE_BYTES = 52_428_800`（50 MiB）等在 `@nano/shared/src/file/` 定义，上传校验、413 文案与测试断言同源。
- **无数量 / 总量上限**：一期不设租户文件数与存储总量配额（存储成本由 R2 计费自然约束），需要配额时再演进。
