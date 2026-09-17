import { describe, expect, it } from 'vitest';
import { normalizeTeamDomain } from '../src/worker/access';

describe('normalizeTeamDomain', () => {
  it('裸域名自动补 https://(JWT iss 带协议头,裸域名必然校验失败)', () => {
    expect(normalizeTeamDomain('shiny-butterfly-54b9.cloudflareaccess.com')).toBe(
      'https://shiny-butterfly-54b9.cloudflareaccess.com',
    );
  });

  it('已带协议头时保持不变,尾部斜杠去掉', () => {
    expect(normalizeTeamDomain('https://team.cloudflareaccess.com/')).toBe(
      'https://team.cloudflareaccess.com',
    );
  });
});
