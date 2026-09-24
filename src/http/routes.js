import { HttpError } from "../domain/errors.js";

const json = (context, status, body) => {
  context.status = status;
  context.body = body;
};

async function readBody(context) {
  if (context.request._parsedBody !== undefined) return context.request._parsedBody;
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    context.req.setEncoding("utf8");
    context.req.on("data", (chunk) => { data += chunk; });
    context.req.on("end", () => resolve(data));
    context.req.on("error", reject);
  });
  if (!raw) {
    context.request._parsedBody = {};
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    context.request._parsedBody = parsed;
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

/**
 * 纯函数式 Koa 路由：所有领域逻辑在 MergerService 中，
 * 这里只做参数提取、角色解析与错误映射。
 */
export function buildRoutes(service) {
  const roleOf = (context) => context.get("x-project-role") || context.query.role || "project_lead";

  return async function router(context) {
    const { method, path } = context;
    try {
      if (method === "GET" && path === "/health") {
        return json(context, 200, { status: "ok", service: "wetland-observation-merger" });
      }

      // 样本 / 批次 / 方法
      if (method === "POST" && path === "/v1/samples") {
        return json(context, 201, service.registerSample(await readBody(context)));
      }
      if (method === "POST" && path === "/v1/batches") {
        return json(context, 201, service.registerBatch(await readBody(context)));
      }
      if (method === "POST" && path === "/v1/methods") {
        return json(context, 201, service.registerMethod(await readBody(context)));
      }
      if (method === "POST" && path === "/v1/methods/corrections") {
        return json(context, 200, service.correctMethod(await readBody(context)));
      }

      // 保管链
      if (method === "POST" && path === "/v1/chain/events") {
        const result = service.appendEvent(await readBody(context));
        return json(context, result.pending ? 202 : 201, result);
      }
      if (method === "GET" && path === "/v1/chain/pending") {
        return json(context, 200, { events: service.listPendingEvents() });
      }

      let match;
      if (method === "POST" && (match = /^\/v1\/chain\/events\/([^/]+)\/adjudications$/.exec(path))) {
        return json(context, 200, service.adjudicateEvent(match[1], await readBody(context)));
      }
      if (method === "POST" && path === "/v1/seals/revocations") {
        return json(context, 200, service.revokeSeal(await readBody(context)));
      }

      // 结果与复测
      if (method === "POST" && path === "/v1/results") {
        return json(context, 201, service.recordResult(await readBody(context)));
      }
      if (method === "POST" && path === "/v1/retests") {
        const body = await readBody(context);
        if (!body.retestOfResultId) {
          throw new HttpError(400, "validation_error", "复测必须指定 retestOfResultId");
        }
        return json(context, 201, service.recordResult(body));
      }
      if (method === "GET" && (match = /^\/v1\/results\/([^/]+)$/.exec(path))) {
        return json(context, 200, service.getResult(match[1]));
      }

      // 结论
      if (method === "GET" && (match = /^\/v1\/conclusions\/([^/]+)$/.exec(path))) {
        return json(context, 200, service.getConclusion(match[1], roleOf(context)));
      }
      if (method === "POST" && (match = /^\/v1\/conclusions\/([^/]+)\/evaluations$/.exec(path))) {
        return json(context, 200, service.evaluateConclusion(match[1], "manual"));
      }
      if (method === "POST" && (match = /^\/v1\/conclusions\/([^/]+)\/confirmations$/.exec(path))) {
        return json(context, 200, service.confirmConclusion(match[1], await readBody(context), roleOf(context)));
      }
      if (method === "GET" && (match = /^\/v1\/conclusions\/([^/]+)\/trace$/.exec(path))) {
        return json(context, 200, service.trace(match[1]));
      }
      if (method === "GET" && path === "/v1/observations") {
        return json(context, 200, service.listObservations(roleOf(context)));
      }

      // 资源查询
      if (method === "GET" && (match = /^\/v1\/samples\/([^/]+)$/.exec(path))) {
        return json(context, 200, service.getSample(match[1]));
      }
      if (method === "GET" && (match = /^\/v1\/tubes\/([^/]+)$/.exec(path))) {
        return json(context, 200, service.getTube(match[1]));
      }

      // 待办与恢复
      if (method === "GET" && path === "/v1/todos") {
        return json(context, 200, service.listTodos());
      }
      if (method === "GET" && path === "/v1/recovery") {
        return json(context, 200, service.recover());
      }
      if (method === "POST" && path === "/v1/recovery") {
        return json(context, 200, service.recover());
      }

      return json(context, 404, { code: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) {
        return json(context, error.status, { code: error.code, message: error.message, details: error.details });
      }
      context.status = 500;
      context.body = { code: "internal_error", message: error.message };
      context.app.emit("error", error, context);
    }
  };
}
