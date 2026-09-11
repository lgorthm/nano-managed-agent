/**
 * Agent 资源标识:agent_ 前缀 + UUIDv7。
 * v7 的时间戳前缀让 ID 天然按创建时间有序,形态与 GLM 的 agent_0191… 一致。
 * Workers 环境没有内置 uuidv7,这里基于 crypto.getRandomValues 自行拼装。
 */
export function newAgentId(): string {
  return `agent_${uuidv7()}`;
}

function uuidv7(): string {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  const timestamp = Date.now();
  // 前 48 位是毫秒级 Unix 时间戳
  view.setUint32(0, Math.floor(timestamp / 0x100000000));
  view.setUint16(4, timestamp % 0x100000000);
  // 其余 80 位随机填充:new Uint8Array(buf, 6, 10) 是同一 buffer 的视图,只覆盖 bytes 6..15
  crypto.getRandomValues(new Uint8Array(buffer, 6, 10));
  // 版本号 7 与 RFC 4122 变体位
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += view.getUint8(i).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
