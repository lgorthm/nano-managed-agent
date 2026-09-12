/**
 * File 资源标识:file_ 前缀 + UUIDv7,形态与 agent_ / skill_ 一致。
 */
import { uuidv7 } from "../uuid";

export function newFileId(): string {
  return `file_${uuidv7()}`;
}
