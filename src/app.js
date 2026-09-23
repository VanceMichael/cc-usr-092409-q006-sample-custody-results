import Koa from "koa";

export function buildApp() {
  const app = new Koa();
  app.use(async (context) => {
    if (context.method === "GET" && context.path === "/health") {
      context.body = { status: "ok", service: "wetland-observation-merger" };
      return;
    }
    context.status = 404;
    context.body = { code: "not_found" };
  });
  return app;
}
