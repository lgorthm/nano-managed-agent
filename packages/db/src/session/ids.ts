/**
 * Session 资源标识:sess_ / sres_ 前缀 + UUIDv7。
 * 与 agent_/env_ 同款约定,时间戳前缀让 ID 天然按创建时间有序。
 */
import { uuidv7 } from '../uuid';

export function newSessionId(): string {
  return `sess_${uuidv7()}`;
}

export function newSessionResourceId(): string {
  return `sres_${uuidv7()}`;
}
