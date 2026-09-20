/**
 * 服务端结构化日志与请求上下文模块。
 *
 * 设计(docs 的 observability 约定):
 * - 结构化 JSON 输出——Workers Logs 官方推荐形态:消息检索直接可用,
 *   OTLP 导出后字段可查询;err 统一序列化为 { name, message, stack };
 * - request_id 经 AsyncLocalStorage 隐式传播(nodejs_compat + compat ≥
 *   2024-09-23 原生支持;2025-06-16 起快照绑定请求生命周期,覆盖 waitUntil),
 *   请求栈深处的 log.* 不需要层层传参即自动携带 requestId 字段;
 * - ALS 不跨 Durable Object RPC / Service Binding 边界(独立 isolate),
 *   跨边界的关联由平台 traces 自动传播;DO 侧日志显式携带 sessionId 字段;
 * - 本模块经子路径 @nano/shared/log 导出,绝不进主入口——web 端 bundle
 *   不能带 node:async_hooks。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化附加字段;err 键会被序列化为 { name, message, stack } */
export interface LogFields {
  [key: string]: unknown;
}

interface RequestLogContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();

/** 请求 id 白名单:受限字符集 + 长度上限(id 会进日志与 span 属性,防伪造/注入) */
const REQUEST_ID_PATTERN = /^req_[0-9A-Za-z-]{8,64}$/;

/** 解析请求 id:传入值合法则沿用(全链路同 id),否则生成新 id */
export function resolveRequestId(incoming: string | null | undefined): string {
  return incoming !== null && incoming !== undefined && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : `req_${crypto.randomUUID()}`;
}

/** 进入请求作用域:入口中间件包裹请求处理;onError / waitUntil 回调显式重进入 */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** 当前请求 id(不在请求作用域内时为 null,如 alarm / fire-and-forget 段) */
export function currentRequestId(): string | null {
  return requestContext.getStore()?.requestId ?? null;
}

/** err 统一序列化:Error 取三要素;非 Error 抛出物降级为字符串 */
function serializeError(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { name: 'NonError', message: String(err) };
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  const requestId = requestContext.getStore()?.requestId;
  const normalized: LogFields = { ...fields };
  if (normalized.err !== undefined) normalized.err = serializeError(normalized.err);
  const line = JSON.stringify({
    level,
    msg,
    ...(requestId !== undefined ? { requestId } : {}),
    ...normalized,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 结构化日志入口:请求作用域内自动携带 requestId 字段 */
export const log = {
  debug(msg: string, fields?: LogFields): void {
    emit('debug', msg, fields);
  },
  info(msg: string, fields?: LogFields): void {
    emit('info', msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    emit('warn', msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    emit('error', msg, fields);
  },
};
