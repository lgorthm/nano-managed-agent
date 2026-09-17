import { catalogEntryToListEntry, MODEL_CATALOG, mergeModelEntries } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { fetchDynamicModelNames } from '../models-api';

/** GET /v1/models — 静态目录 + Workers AI 线上目录动态合并(console 模型选择的数据源) */
export async function listModels(c: Context<AppEnv>) {
  const staticEntries = MODEL_CATALOG.map(catalogEntryToListEntry);
  const dynamicNames = await fetchDynamicModelNames(c.env);
  return c.json({ data: mergeModelEntries(staticEntries, dynamicNames ?? []) });
}
