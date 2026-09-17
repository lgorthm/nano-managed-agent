/**
 * 工具执行层(runtime.md §4 第 3 步)。注入边界:turn 执行器只认 ToolRunner
 * 接口;真实沙箱(Sandbox SDK,依赖容器,进不了 vitest)与测试 mock 在此分流,
 * 集成测试以 mock 执行器覆盖循环语义,真实沙箱走 curl 冒烟与脚本。
 *
 * 沙箱生命周期遵循 §4.5 决策:每会话一个实例(id = sessionId)、按需冷启、
 * 不启用 keepAlive、空闲回收交给平台默认 sleepAfter(10m)。sleep 即状态
 * 清零,因此物化协议必须自带幂等标记(容器内的 /tmp 标记文件随新容器消失,
 * 天然触发再物化;DO 实例内的内存标记避免热容器上的重复物化)。
 */
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import {
  BUILTIN_TOOL_INPUT_SCHEMAS,
  type BuiltinToolName,
  fileObjectKey,
  type NormalizedEnvironmentPackages,
} from '@nano/shared';
import type { Env } from '../../env';
import { type HarvestedOutput, harvestSessionOutputs } from './catalog';

const WORKSPACE = '/workspace';
const UPLOADS_ROOT = '/mnt/session/uploads';
const OUTPUTS_DIR = '/mnt/session/outputs';
const SKILLS_ROOT = '/mnt/skills';
const MATERIALIZE_MARKER = '/tmp/.nano-materialized';
/** 单个工具输出回喂模型的截断上限(字符),防爆上下文 */
const TOOL_OUTPUT_LIMIT = 200_000;

export interface ToolInvocation {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** 物化协议所需的会话侧数据(D1 一次读齐,DO 组装) */
export interface ToolSessionContext {
  sessionId: string;
  /** 挂载文件:mounth_path 已归一化,内容在 R2(files/{file_id}) */
  resources: Array<{ fileId: string; mountPath: string }>;
  /** 会话产出编目(session_outputs):冷启回填 outputs 目录用,内容在 R2 */
  outputs: Array<{ fileId: string; path: string }>;
  /** skills 目录快照:内容已从 skill_files 读出 */
  skills: Array<{
    directory: string;
    files: Array<{ path: string; content: Uint8Array }>;
  }>;
  /** environment 快照的包声明(创建时固化;安装尽力而为,networking 三期) */
  packages: NormalizedEnvironmentPackages | null;
}

export interface ToolRunner {
  /** 冷启掩体(§4.5):与模型调用并行预热情性沙箱,失败静默 */
  warmup(): Promise<void>;
  /** 执行一次工具调用;实现保证不抛(一切失败以 isError 结果喂回模型) */
  run(invocation: ToolInvocation): Promise<ToolOutcome>;
  /** turn 收尾:outputs 目录同步进 R2(§4.5 物化协议,幂等) */
  harvestOutputs(): Promise<void>;
  /** 会话终态(删除 / 归档)联动:显式销毁沙箱 */
  destroy(): Promise<void>;
}

// ---------- 小工具 ----------

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 相对路径按工作目录(/workspace)解析 */
function resolvePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE}/${path}`;
}

function truncateToolOutput(content: string): string {
  if (content.length <= TOOL_OUTPUT_LIMIT) return content;
  return `${content.slice(0, TOOL_OUTPUT_LIMIT)}\n…[truncated, ${content.length - TOOL_OUTPUT_LIMIT} chars omitted]`;
}

// ---------- mock 实现(vitest;行为被集成测试依赖) ----------

/**
 * mock 执行器:回显调用(name + input)供断言;bash 命令以 "slow" 开头时
 * 睡 1.5s,供「中断在途执行」「逐出恢复」类用例制造时序窗口。
 */
export class MockToolRunner implements ToolRunner {
  async warmup(): Promise<void> {}
  async run(invocation: ToolInvocation): Promise<ToolOutcome> {
    const input = (invocation.input ?? {}) as Record<string, unknown>;
    if (
      invocation.name === 'bash' &&
      typeof input.command === 'string' &&
      input.command.startsWith('slow')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        content: `slow command finished: ${input.command}`,
        isError: false,
      };
    }
    return {
      content: `mock:${invocation.name}:${JSON.stringify(input)}`,
      isError: false,
    };
  }
  async harvestOutputs(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/** 沙箱绑定缺失且未开 mock(配置错误):显式报错给模型与日志 */
class UnavailableToolRunner implements ToolRunner {
  async warmup(): Promise<void> {}
  async run(): Promise<ToolOutcome> {
    return {
      content: 'Tool execution is unavailable: no sandbox binding is configured.',
      isError: true,
    };
  }
  async harvestOutputs(): Promise<void> {}
  async destroy(): Promise<void> {}
}

// ---------- 真实沙箱实现 ----------

export class SandboxToolRunner implements ToolRunner {
  private sandbox: Sandbox | null = null;
  private materialized = false;

  constructor(
    private readonly env: Env,
    private readonly ctx: ToolSessionContext,
  ) {}

  private sbx(): Sandbox {
    if (this.sandbox === null) {
      // §4.5:显式给 sleepAfter(等于平台默认 10m),keepAlive 恒不启用
      this.sandbox = getSandbox(this.env.SANDBOX!, this.ctx.sessionId, {
        sleepAfter: '10m',
      });
    }
    return this.sandbox;
  }

  private exec(command: string, timeoutMs?: number) {
    return this.sbx().exec(command, {
      cwd: WORKSPACE,
      timeout: timeoutMs,
      origin: 'internal',
    });
  }

  async warmup(): Promise<void> {
    try {
      await this.ensureMaterialized();
    } catch (err) {
      console.error('sandbox warmup failed (lazy start will retry):', err);
    }
  }

  /** 物化协议(§4.5):uploads 只读供给、skills、outputs 回填、环境包安装;幂等 */
  private async ensureMaterialized(): Promise<void> {
    if (this.materialized) return;
    const marker = await this.sbx().exists(MATERIALIZE_MARKER);
    if (marker.exists) {
      this.materialized = true;
      return;
    }
    await this.exec(`mkdir -p ${WORKSPACE} ${UPLOADS_ROOT} ${OUTPUTS_DIR} ${SKILLS_ROOT}`);

    for (const resource of this.ctx.resources) {
      const object = await this.env.FILES.get(fileObjectKey(resource.fileId));
      if (object === null) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      await this.exec(`mkdir -p $(dirname ${shellQuote(resource.mountPath)})`);
      await this.sbx().writeFile(resource.mountPath, bytesToBase64(bytes), {
        encoding: 'base64',
      });
    }
    if (this.ctx.resources.length > 0) {
      // uploads 只读语义:尽力而为地收回写权限(平台无只读挂载原语)
      await this.exec(`chmod -R a-w ${UPLOADS_ROOT}`).catch(() => undefined);
    }

    for (const skill of this.ctx.skills) {
      const dir = `${SKILLS_ROOT}/${skill.directory}`;
      for (const file of skill.files) {
        await this.sbx().writeFile(`${dir}/${file.path}`, bytesToBase64(file.content), {
          encoding: 'base64',
        });
      }
    }

    for (const output of this.ctx.outputs) {
      const object = await this.env.FILES.get(fileObjectKey(output.fileId));
      if (object === null) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      await this.sbx().writeFile(`${OUTPUTS_DIR}/${output.path}`, bytesToBase64(bytes), {
        encoding: 'base64',
      });
    }

    if (this.ctx.packages !== null) await this.applyPackages(this.ctx.packages);

    await this.sbx().writeFile(MATERIALIZE_MARKER, String(Date.now()));
    this.materialized = true;
  }

  /** environment 快照的包安装:全命令尽力而为(基础镜像缺对应包管理器时跳过) */
  private async applyPackages(packages: NormalizedEnvironmentPackages): Promise<void> {
    const join = (values: string[]): string => values.map(shellQuote).join(' ');
    const attempts: Array<readonly [boolean, string]> = [
      [
        packages.apt.length > 0,
        `(command -v apt-get >/dev/null && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${join(packages.apt)}) || echo 'apt unavailable'`,
      ],
      [
        packages.pip.length > 0,
        `(command -v pip3 >/dev/null && pip3 install -q --break-system-packages ${join(packages.pip)}) || (command -v pip3 >/dev/null && pip3 install -q ${join(packages.pip)}) || echo 'pip unavailable'`,
      ],
      [
        packages.npm.length > 0,
        `(command -v npm >/dev/null && npm install -g ${join(packages.npm)}) || echo 'npm unavailable'`,
      ],
      [
        packages.go.length > 0,
        `(command -v go >/dev/null && go install ${join(packages.go.map((pkg) => `${pkg}@latest`))}) || echo 'go unavailable'`,
      ],
      [
        packages.cargo.length > 0,
        `(command -v cargo >/dev/null && cargo install ${join(packages.cargo)}) || echo 'cargo unavailable'`,
      ],
      [
        packages.gem.length > 0,
        `(command -v gem >/dev/null && gem install ${join(packages.gem)}) || echo 'gem unavailable'`,
      ],
    ];
    for (const [applicable, command] of attempts) {
      if (!applicable) continue;
      await this.exec(command, 600_000);
    }
  }

  async run(invocation: ToolInvocation): Promise<ToolOutcome> {
    try {
      await this.ensureMaterialized();
      const schema = BUILTIN_TOOL_INPUT_SCHEMAS[invocation.name as BuiltinToolName];
      if (schema === undefined) {
        return { content: `Unknown tool "${invocation.name}".`, isError: true };
      }
      const parsed = schema.safeParse(invocation.input ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content:
            `Invalid arguments for ${invocation.name}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
          isError: true,
        };
      }
      const input = parsed.data as Record<string, unknown>;
      switch (invocation.name as BuiltinToolName) {
        case 'bash': {
          const result = await this.sbx().exec(String(input.command), {
            cwd: WORKSPACE,
            timeout: input.timeout_ms !== undefined ? Number(input.timeout_ms) : undefined,
          });
          let content = result.stdout;
          if (result.stderr !== '')
            content += `${content === '' ? '' : '\n'}[stderr]\n${result.stderr}`;
          if (result.exitCode !== 0) content += `\n[exit code ${result.exitCode}]`;
          return {
            content: truncateToolOutput(content),
            isError: !result.success,
          };
        }
        case 'read': {
          const file = await this.sbx().readFile(resolvePath(String(input.path)), {
            encoding: 'utf-8',
          });
          return { content: truncateToolOutput(file.content), isError: false };
        }
        case 'write': {
          const path = resolvePath(String(input.path));
          await this.exec(`mkdir -p $(dirname ${shellQuote(path)})`);
          await this.sbx().writeFile(path, String(input.content));
          return { content: `Wrote ${input.path}.`, isError: false };
        }
        case 'edit': {
          const path = resolvePath(String(input.path));
          const file = await this.sbx().readFile(path, { encoding: 'utf-8' });
          const oldString = String(input.old_string);
          const count = file.content.split(oldString).length - 1;
          if (count === 0) {
            return {
              content: `old_string not found in ${input.path}.`,
              isError: true,
            };
          }
          if (count > 1) {
            return {
              content: `old_string occurs ${count} times in ${input.path}; it must be unique.`,
              isError: true,
            };
          }
          await this.sbx().writeFile(
            path,
            file.content.replace(oldString, String(input.new_string)),
          );
          return { content: `Edited ${input.path}.`, isError: false };
        }
        case 'grep': {
          const target = shellQuote(
            input.path !== undefined ? resolvePath(String(input.path)) : WORKSPACE,
          );
          // grep exit 1 = 无匹配,是正常结果而非错误
          const result = await this.exec(
            `grep -rnE --include='*' -- ${shellQuote(String(input.pattern))} ${target}`,
          );
          return {
            content: truncateToolOutput(result.stdout === '' ? '(no matches)' : result.stdout),
            isError: false,
          };
        }
        case 'find': {
          const name =
            input.pattern !== undefined ? ` -name ${shellQuote(String(input.pattern))}` : '';
          const result = await this.exec(
            `find ${shellQuote(input.path !== undefined ? resolvePath(String(input.path)) : WORKSPACE)} -type f${name}`,
          );
          return { content: truncateToolOutput(result.stdout), isError: false };
        }
        case 'ls': {
          const result = await this.exec(
            `ls -la ${shellQuote(input.path !== undefined ? resolvePath(String(input.path)) : WORKSPACE)}`,
          );
          return { content: truncateToolOutput(result.stdout), isError: false };
        }
      }
    } catch (err) {
      console.error(`tool ${invocation.name} failed:`, err);
      return {
        content: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  /** turn 收尾:outputs 快照收敛成 File 资源编目(§4.5 物化协议,catalog.ts) */
  async harvestOutputs(): Promise<void> {
    try {
      await this.ensureMaterialized();
      const listed = await this.exec(`find ${OUTPUTS_DIR} -type f`);
      const paths = listed.stdout.split('\n').filter((line) => line !== '');
      const files: HarvestedOutput[] = [];
      for (const path of paths) {
        if (!path.startsWith(`${OUTPUTS_DIR}/`)) continue;
        const file = await this.sbx().readFile(path, { encoding: 'base64' });
        files.push({
          path: path.slice(OUTPUTS_DIR.length + 1),
          bytes: base64ToBytes(file.content),
        });
      }
      await harvestSessionOutputs(this.env, this.ctx.sessionId, files);
    } catch (err) {
      console.error('sandbox outputs harvest failed:', err);
    }
  }

  async destroy(): Promise<void> {
    try {
      await this.sbx().destroy();
    } catch (err) {
      // 销毁是终态联动的尽力而为(沙箱可能从未创建或已自然消亡)
      console.error('sandbox destroy failed:', err);
    }
  }
}

/** 按环境分流:测试 mock 优先,其次真实沙箱绑定,都没有则显式不可用 */
export function createToolRunner(env: Env, ctx: ToolSessionContext): ToolRunner {
  if (env.TOOL_SANDBOX_MOCK === '1') return new MockToolRunner();
  if (env.SANDBOX !== undefined) return new SandboxToolRunner(env, ctx);
  return new UnavailableToolRunner();
}
