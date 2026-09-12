/**
 * Environment 资源标识:env_ 前缀 + UUIDv7。
 * v7 的时间戳前缀让 ID 天然按创建时间有序,形态与 GLM 的 env_019e… 一致。
 */
import { uuidv7 } from "../uuid";

export function newEnvironmentId(): string {
  return `env_${uuidv7()}`;
}
