/**
 * Agent 资源标识:agent_ 前缀 + UUIDv7。
 * v7 的时间戳前缀让 ID 天然按创建时间有序,形态与 GLM 的 agent_0191… 一致。
 */
import { uuidv7 } from '../uuid';

export function newAgentId(): string {
  return `agent_${uuidv7()}`;
}
