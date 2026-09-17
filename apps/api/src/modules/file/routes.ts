import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { deleteFile } from './handlers/delete-file';
import { downloadFileContent } from './handlers/download-file';
import { getFile } from './handlers/get-file';
import { listFiles } from './handlers/list-files';
import { uploadFile } from './handlers/upload-file';

/** File 资源子路由;端点与 docs/files/api/*.md 一一对应 */
export const fileRoutes = new Hono<AppEnv>();

fileRoutes.post('/', uploadFile);
fileRoutes.get('/', listFiles);
// content 路径更长,先注册避免被 :fileId 捕获
fileRoutes.get('/:fileId/content', downloadFileContent);
fileRoutes.delete('/:fileId', deleteFile);
fileRoutes.get('/:fileId', getFile);
