/**
 * Cloudflare Access 当前登录身份。应用在 Access 保护之下时,
 * 同域 /cdn-cgi/access/get-identity 返回 { name, email, ... };
 * 本地 vite dev 没有 Access,返回 null(页面显示 local dev)。
 */
export interface AccessIdentity {
  id?: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export async function getIdentity(): Promise<AccessIdentity | null> {
  try {
    const res = await fetch('/cdn-cgi/access/get-identity');
    if (!res.ok) return null;
    return (await res.json()) as AccessIdentity;
  } catch {
    return null;
  }
}
