import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  // 迁移输出到 apps/api,与 D1 绑定同侧,由 wrangler d1 migrations 执行
  out: '../../apps/api/migrations',
});
