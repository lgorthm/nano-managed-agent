import { Hono } from "hono";
import type { AppEnv } from "./env";
import { honoOnError } from "./lib/errors";
import { requestId } from "./lib/request-id";
import { v1 } from "./routes/v1";

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.onError(honoOnError);

app.get("/", (c) => c.text("Hello from nano-managed-agent"));

app.route("/v1", v1);

export default app;
