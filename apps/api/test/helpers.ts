/** 与 .dev.vars / .dev.vars.example 约定的本地 API key 保持一致 */
export const API_KEY = 'dev-key-change-me';

/** 携带正确认证的请求头 */
export function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, ...headers };
}
