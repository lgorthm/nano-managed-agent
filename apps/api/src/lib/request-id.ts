import { tracing } from 'cloudflare:workers';
import { log, resolveRequestId, withRequestId } from '@nano/shared/log';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { AppEnv } from '../env';

/**
 * 每请求唯一 request_id 的装配点:
 * - 优先沿用网关 / console 转发的 x-request-id(白名单校验,全链路同 id),
 *   否则生成 req_<uuid>;
 * - ALS(withRequestId)包裹请求处理:作用域内所有 log.* 自动携带 requestId
 *   字段,调用栈深处无需层层传参;
 * - tracing.enterSpan 把 id 写成 span 属性 app.request_id——Workers Logs 里
 *   logs(requestId 字段)与 traces(span 属性)两个维度都能按 id 检索,命中
 *   trace 即得跨 Worker / DO / D1 的完整瀑布(上下文由平台自动传播);
 * - 成功路径:完成行日志 + x-request-id 响应头;错误路径由 honoOnError 负责
 *   (onError 在 ALS 帧外执行,在那里显式重进入)。
 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = resolveRequestId(c.req.header('x-request-id'));
  c.set('requestId', id);
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const startedAt = Date.now();
  await tracing.enterSpan('app.request', async (span) => {
    span.setAttribute('app.request_id', id);
    span.setAttribute('http.request.method', method);
    span.setAttribute('url.path', path);
    await withRequestId(id, async () => {
      await next();
      c.res.headers.set('x-request-id', id);
      // 路由模板(如 /v1/sessions/:id)在 next() 之后才可得知(路由已匹配完毕)。
      // url.path 带具体资源 id 是高基数维度;route 是低基数的「端点」维度,
      // 按端点聚合/过滤靠它。span 属性与日志字段各补一份
      const route = routePath(c);
      const hasRoute = route !== '' && route !== '*';
      if (hasRoute) span.setAttribute('http.route', route);
      if (c.env.LOG_REQUEST_COMPLETION !== '0') {
        // 完成行必须在 ALS 作用域内记,自动携带 requestId 字段。
        // msg 直接拼上 method/path/status:Workers Logs 列表只展示 msg,
        // 只写 'request completed' 的话列表里根本看不出这条请求是什么;
        // 结构化字段保持不变,字段级过滤(path=/status= 等)能力不受影响
        log.info(`request completed: ${method} ${path} ${c.res.status}`, {
          method,
          path,
          ...(hasRoute ? { route } : {}),
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  });
});
