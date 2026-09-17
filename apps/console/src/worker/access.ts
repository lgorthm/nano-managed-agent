import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';

/**
 * 校验请求携带的 Cloudflare Access JWT(Cf-Access-Jwt-Assertion 头)。
 * Access 挡在域名前面是第一道防线;这里是第二道——即使 Access 策略
 * 配置有疏漏(如 workers.dev 域名未关),没有有效 JWT 也调不到代理。
 *
 * 校验方式见 Cloudflare 官方文档:JWKS 取自
 * {team_domain}/cdn-cgi/access/certs,验证 issuer 与 audience(AUD Tag)。
 */
/** 容忍配置写法偏差:自动补 https:// 协议头、去尾部斜杠(JWT 的 iss 带协议头,裸域名必然校验失败) */
export function normalizeTeamDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function assertAccess(request: Request, env: Env): Promise<Response | null> {
  if (env.ACCESS_DEV_BYPASS === '1') return null;

  const teamDomainRaw = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomainRaw || !aud || teamDomainRaw.startsWith('TODO') || aud.startsWith('TODO')) {
    return Response.json(
      {
        error: {
          type: 'config_error',
          message:
            "CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not configured: set the Zero Trust application's Team Domain and AUD Tag in wrangler.jsonc vars, see docs/console.md",
        },
      },
      { status: 503 },
    );
  }
  const teamDomain = normalizeTeamDomain(teamDomainRaw);

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    return Response.json(
      {
        error: {
          type: 'unauthorized',
          message: 'Missing Cloudflare Access JWT (not signed in via Access)',
        },
      },
      { status: 401 },
    );
  }

  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    await jwtVerify(token, jwks, { issuer: teamDomain, audience: aud });
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        error: {
          type: 'unauthorized',
          message: `Cloudflare Access JWT validation failed (team=${teamDomain}, aud=${aud.slice(0, 8)}…): ${reason}`,
        },
      },
      { status: 401 },
    );
  }
}
