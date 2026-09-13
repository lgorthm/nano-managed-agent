import { Hono } from "hono";
import type { AppEnv } from "./env";
import { honoOnError } from "./lib/errors";
import { requestId } from "./lib/request-id";
import { v1 } from "./routes/v1";

// 会话运行时的 Durable Object 必须从主模块导出(wrangler.jsonc 的 durable_objects 绑定);
// Sandbox 是工具沙箱的 DO 类(@cloudflare/sandbox,containers 配置见 wrangler.jsonc)
export { SessionDo } from "./runtime/do/session-do";
export { Sandbox } from "@cloudflare/sandbox";

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.onError(honoOnError);

app.get("/", (c) => c.text("Hello from nano-managed-agent"));

app.route("/v1", v1);

export default app;
