/**
 * 运行时 ID 生成(runtime.md §2.1 / §4.1):sevt_ / trn_ 前缀 + UUIDv7。
 * 这些 ID 永不进入 D1,因此放在运行时一侧,不进 packages/db 的模块 ids。
 */
import { uuidv7 } from '@nano/db';

export function newEventId(): string {
  return `sevt_${uuidv7()}`;
}

export function newTurnId(): string {
  return `trn_${uuidv7()}`;
}
