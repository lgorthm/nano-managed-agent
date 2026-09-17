/**
 * SESSION_DO 的访问帮助:按 sessionId 取 stub,并把 DO 的结果对象翻译回 ApiError。
 * DO 侧可预期错误以 DoResult 失败分支返回(不抛出——DO 侧异常会被测试基线记为
 * unhandled);未预期的传输错误走异常路径,onError 兜底为 500。
 */
import type { Env } from '../env';
import { ApiError, conflictError, invalidRequestError, notFoundError } from '../lib/errors';
import type { DoResult, SessionDo } from './do/session-do';

export function sessionDoStub(env: Env, sessionId: string): DurableObjectStub<SessionDo> {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
}

/** 解包 DO 结果:失败分支按 status 翻译为对应 ApiError 并抛出 */
export function unwrapDoResult<T>(result: DoResult<T>): T {
  if (result.ok) return result.value;
  if (result.status === 400) throw invalidRequestError(result.message);
  if (result.status === 404) throw notFoundError(result.message);
  if (result.status === 409) throw conflictError(result.message);
  if (result.status === 429) throw new ApiError('rate_limit_error', result.message);
  throw new ApiError('api_error', result.message);
}
