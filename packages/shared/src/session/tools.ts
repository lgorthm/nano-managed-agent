/**
 * 内置工具集(agent_toolset_20260601)的执行侧定义(runtime.md §1 / §4)。
 * 一处定义同时服务两件事:模型侧的 chat completions tools 参数(名称 /
 * 描述 / JSON Schema)与执行侧的入参校验(zod);权限解析把归一化后的
 * agent_config.tools 折叠成「工具名 → 权限」表,M2 只放行 always_allow,
 * always_ask 的挂起语义属 M3。
 */
import { z } from "zod";
import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "../agent/schemas";
import type { NormalizedAgentToolset, NormalizedBuiltinToolset } from "../agent/normalize";

/** chat completions 的 function 工具定义(GLM / OpenAI 兼容形态) */
export interface ChatToolDefinition {
  type: "function";
  function: {
    name: BuiltinToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> = {
  bash:
    "Run a bash command in the session sandbox. The working directory persists between calls within the session. Use this for building, running scripts, and any shell work.",
  read: "Read a file from the sandbox filesystem. Returns the file content as UTF-8 text.",
  write:
    "Write a file to the sandbox filesystem. Creates parent directories as needed and overwrites the file if it exists.",
  edit:
    "Edit a file by replacing an exact string. The file must exist and old_string must match the text to replace exactly once.",
  grep:
    "Search file contents with a regular expression (extended regex, like egrep) under a path. Returns matching lines with file names and line numbers.",
  find: "Find files by name pattern (shell glob, e.g. '*.csv') under a path. Returns matching paths.",
  ls: "List the contents of a directory in the sandbox filesystem.",
};

/** 各工具入参的 JSON Schema(与 zod 校验一一对应,手工同步) */
const TOOL_PARAMETERS: Record<BuiltinToolName, Record<string, unknown>> = {
  bash: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute." },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 600000,
        description: "Optional execution timeout in milliseconds.",
      },
    },
    required: ["command"],
  },
  read: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute or workspace-relative file path." } },
    required: ["path"],
  },
  write: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or workspace-relative file path." },
      content: { type: "string", description: "Full file content to write (UTF-8)." },
    },
    required: ["path", "content"],
  },
  edit: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old_string: { type: "string", description: "Exact text to replace; must occur exactly once." },
      new_string: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_string", "new_string"],
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Extended regular expression." },
      path: { type: "string", description: "File or directory to search; defaults to the workspace." },
    },
    required: ["pattern"],
  },
  find: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Name glob like '*.md'; defaults to all files." },
      path: { type: "string", description: "Directory to search; defaults to the workspace." },
    },
  },
  ls: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path; defaults to the workspace." } },
  },
};

/** 模型侧定义表(bash 排首位,最常用) */
export const BUILTIN_TOOL_DEFINITIONS: Record<BuiltinToolName, ChatToolDefinition> = Object.fromEntries(
  BUILTIN_TOOL_NAMES.map((name) => [
    name,
    {
      type: "function",
      function: { name, description: TOOL_DESCRIPTIONS[name], parameters: TOOL_PARAMETERS[name] },
    },
  ]),
) as Record<BuiltinToolName, ChatToolDefinition>;

// ---------- 执行侧入参校验(模型生成物不可信,必须校验) ----------

const PathSchema = z.string().min(1).max(4096);

export const BashInputSchema = z.strictObject({
  command: z.string().min(1).max(65536),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
});
export const ReadInputSchema = z.strictObject({ path: PathSchema });
export const WriteInputSchema = z.strictObject({ path: PathSchema, content: z.string().max(2_097_152) });
export const EditInputSchema = z.strictObject({
  path: PathSchema,
  old_string: z.string().min(1).max(131_072),
  new_string: z.string().max(131_072),
});
export const GrepInputSchema = z.strictObject({ pattern: z.string().min(1).max(8192), path: PathSchema.optional() });
export const FindInputSchema = z.strictObject({ pattern: z.string().min(1).max(1024).optional(), path: PathSchema.optional() });
export const LsInputSchema = z.strictObject({ path: PathSchema.optional() });

/** 各工具的入参校验表;校验失败的调用以 is_error 的 tool_result 喂回模型,不炸 turn */
export const BUILTIN_TOOL_INPUT_SCHEMAS: Record<BuiltinToolName, z.ZodTypeAny> = {
  bash: BashInputSchema,
  read: ReadInputSchema,
  write: WriteInputSchema,
  edit: EditInputSchema,
  grep: GrepInputSchema,
  find: FindInputSchema,
  ls: LsInputSchema,
};

/**
 * 执行前的协议级校验(在执行器做,不依赖具体 runner 实现):未知工具或
 * 入参非法返回错误消息(null 表示通过)。校验失败的调用不进沙箱,
 * 直接以 is_error 的 tool_result 喂回模型。
 */
export function validateToolInvocation(name: string, input: unknown): string | null {
  const schema = BUILTIN_TOOL_INPUT_SCHEMAS[name as BuiltinToolName];
  if (schema === undefined) return `Unknown tool "${name}".`;
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".");
  return `Invalid arguments for ${name}: ${path !== "" ? `${path} ` : ""}${issue?.message ?? ""}`.trim();
}

// ---------- 权限解析 ----------

export interface ResolvedBuiltinTool {
  name: BuiltinToolName;
  permission: "always_allow" | "always_ask";
}

/**
 * 归一化后的 agent_config.tools → 内置工具的「名称 → 启用与权限」表。
 * 继承已在 agent 归一化时解析(default_config 补全、configs 覆盖),
 * 这里只折叠:configs 覆盖同名工具,未提及的工具取 default_config。
 */
export function resolveBuiltinTools(toolsets: readonly NormalizedAgentToolset[]): ResolvedBuiltinTool[] {
  const builtin = toolsets.filter(
    (toolset): toolset is NormalizedBuiltinToolset => toolset.type === "agent_toolset_20260601",
  );
  const resolved = new Map<BuiltinToolName, ResolvedBuiltinTool>();
  for (const toolset of builtin) {
    for (const name of BUILTIN_TOOL_NAMES) {
      const override = toolset.configs.find((config) => config.name === name);
      const config = override ?? toolset.default_config;
      if (!config.enabled) {
        resolved.delete(name);
        continue;
      }
      resolved.set(name, { name, permission: config.permission_policy.type });
    }
  }
  return BUILTIN_TOOL_NAMES.filter((name) => resolved.has(name)).map((name) => resolved.get(name)!);
}
