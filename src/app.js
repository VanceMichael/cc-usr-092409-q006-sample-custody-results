import Koa from "koa";
import { ChainIntegrityError, DomainError } from "./errors.js";
import { createService } from "./service.js";
import { publicConclusion, publicResult } from "./custody.js";

/**
 * HTTP 适配层。所有状态变更都要求幂等键：
 * - Idempotency-Key 头或 body.request_id：请求级幂等（重试安全）；
 * - body.scan_nonce：扫码事务号，同一物理扫码动作只生效一次。
 */
export function buildApp({ service } = {}) {
  const runtime = service ?? createService().service;
  const app = new Koa();

  app.use(async (context) => {
    try {
      await route(context, runtime);
    } catch (error) {
      if (error instanceof DomainError) {
        context.status = error.status;
        context.body = { code: error.code, message: error.message, details: error.details ?? null };
        return;
      }
      if (error instanceof ChainIntegrityError) {
        context.status = 500;
        context.body = { code: error.code, message: error.message, details: error.details ?? null };
        return;
      }
      if (error instanceof SyntaxError) {
        context.status = 400;
        context.body = { code: "invalid_json", message: "请求体不是合法 JSON" };
        return;
      }
      throw error;
    }
  });

  return app;
}

async function readBody(context) {
  if (context.method === "GET" || context.method === "HEAD") return {};
  const text = await readRawBody(context.req);
  if (!text) return {};
  return JSON.parse(text);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function options(context, body) {
  return { ...body, request_id: context.get("idempotency-key") || body.request_id || undefined };
}

async function route(context, service) {
  const { path } = context;

  if (context.method === "GET" && path === "/health") {
    context.body = { status: "ok", service: "wetland-observation-merger", seq: service.log.seq };
    return;
  }

  const body = await readBody(context);

  // ---- 项目策略（敏感物种与位置精度） ----
  let match;
  if (context.method === "POST" && (match = path.match(/^\/v1\/projects\/([^/]+)\/policy$/))) {
    service.upsertProject(match[1], { ...body, updated_by: body.updated_by || context.get("x-actor") || undefined });
    context.status = 204;
    return;
  }

  // ---- 现场样本 ----
  if (context.method === "POST" && path === "/v1/samples") {
    const out = service.collectSample(options(context, body));
    context.status = out.duplicated ? 200 : 201;
    context.body = { sample_id: out.sample.id, duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "GET" && (match = path.match(/^\/v1\/samples\/([^/]+)$/))) {
    const sample = service.samples.get(match[1]);
    if (!sample) throw new DomainError("sample_not_found", "样本不存在", { status: 404 });
    context.body = {
      sample_id: sample.id,
      project_id: sample.project_id,
      site: sample.site,
      matrix: sample.matrix,
      state: sample.state,
      collected_at: sample.collected_at,
      collector: sample.collector,
      event_count: sample.events.length,
    };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/samples\/([^/]+)\/destroy$/))) {
    const out = service.destroySample(match[1], withOperator(context, body));
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }

  // ---- 分装管 ----
  if (context.method === "POST" && (match = path.match(/^\/v1\/samples\/([^/]+)\/aliquots$/))) {
    const out = service.prepareAliquot(match[1], {
      ...options(context, body),
      prepared_by: body.prepared_by || context.get("x-actor") || undefined,
    });
    context.status = out.duplicated ? 200 : 201;
    context.body = { aliquot_id: out.aliquot.id, seal_id: out.aliquot.seal_id, duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "GET" && (match = path.match(/^\/v1\/aliquots\/([^/]+)$/))) {
    const aliquot = service.aliquots.get(match[1]);
    if (!aliquot) throw new DomainError("aliquot_not_found", "分装管不存在", { status: 404 });
    context.body = {
      aliquot_id: aliquot.id,
      sample_id: aliquot.sample_id,
      tube_barcode: aliquot.tube_barcode,
      seal_id: aliquot.seal_id,
      seal_revoked: aliquot.seal_revoked ?? null,
      destination_lab: aliquot.destination_lab,
      state: aliquot.state,
      holder: aliquot.holder,
      handovers: aliquot.handovers,
      events: aliquot.events.map((event) => ({
        event_id: event.event_id,
        type: event.type,
        occurred_at: event.occurred_at,
        operator: event.operator,
        offline: event.offline,
        temp: event.temp,
        content_digest: event.content_digest,
      })),
    };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/handovers$/))) {
    const out = service.openHandover(match[1], {
      ...options(context, body),
      shipped_by: body.shipped_by || context.get("x-actor") || undefined,
    });
    context.status = out.duplicated ? 200 : 201;
    context.body = { handover_id: out.handover_id, duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/store$/))) {
    const out = service.store(match[1], withOperator(context, options(context, body)));
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/open$/))) {
    const out = service.open(match[1], withOperator(context, options(context, body)));
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/revoke-seal$/))) {
    const out = service.revokeSeal(match[1], withOperator(context, options(context, body)));
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/destroy$/))) {
    const out = service.destroyAliquot(match[1], withOperator(context, options(context, body)));
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/aliquots\/([^/]+)\/adjudications$/))) {
    const out = service.adjudicate(match[1], {
      ...options(context, body),
      reviewer: body.reviewer || context.get("x-actor") || undefined,
    });
    context.body = { duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }

  // ---- 交接确认（封签并发确认只有一个成功） ----
  if (context.method === "POST" && (match = path.match(/^\/v1\/handovers\/([^/]+)\/accept$/))) {
    const out = service.acceptHandover(match[1], {
      ...options(context, body),
      receiver: body.receiver || context.get("x-actor") || undefined,
    });
    context.body = { handover_id: out.handover_id, duplicated: out.duplicated, breaks: out.breaks, event_id: out.event.event_id };
    return;
  }

  // ---- 检测批次与结果 ----
  if (context.method === "POST" && path === "/v1/batches") {
    const out = service.registerBatch({ ...options(context, body), operator: body.operator || context.get("x-actor") || undefined });
    context.status = out.duplicated ? 200 : 201;
    context.body = { batch_id: out.batch.id, duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/batches\/([^/]+)\/results$/))) {
    const out = service.recordResult(match[1], { ...options(context, body), analyst: body.analyst || context.get("x-actor") || undefined });
    context.status = out.duplicated ? 200 : 201;
    context.body = { result: publicResult(out.result), duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/results\/([^/]+)\/corrections$/))) {
    const out = service.correctResult(match[1], { ...options(context, body), corrected_by: body.corrected_by || context.get("x-actor") || undefined });
    context.body = { result: publicResult(out.result), duplicated: out.duplicated, event_id: out.event.event_id };
    return;
  }

  // ---- 结论 ----
  if (context.method === "POST" && (match = path.match(/^\/v1\/samples\/([^/]+)\/conclusions\/([^/]+)\/evaluate$/))) {
    const conclusion = service.evaluate(match[1], decodeURIComponent(match[2]));
    context.body = { conclusion: publicConclusion(conclusion) };
    return;
  }
  if (context.method === "POST" && (match = path.match(/^\/v1\/conclusions\/([^/]+)\/confirm$/))) {
    const conclusion = service.confirmConclusion(match[1], {
      ...options(context, body),
      reviewer: body.reviewer || context.get("x-actor") || undefined,
    });
    context.body = { conclusion: publicConclusion(conclusion) };
    return;
  }
  if (context.method === "GET" && (match = path.match(/^\/v1\/conclusions\/([^/]+)\/trace$/))) {
    context.body = service.trace(match[1]);
    return;
  }
  if (context.method === "GET" && (match = path.match(/^\/v1\/conclusions\/([^/]+)$/))) {
    const conclusion = service.conclusions.get(match[1]);
    if (!conclusion) throw new DomainError("conclusion_not_found", "结论不存在", { status: 404 });
    context.body = { conclusion: publicConclusion(conclusion) };
    return;
  }

  // ---- 观测窗口与降精度查询 ----
  if (context.method === "POST" && path === "/v1/windows") {
    const window = service.registerWindow({ ...options(context, body), operator: body.operator || context.get("x-actor") || undefined });
    context.status = 201;
    context.body = { window_id: window.id };
    return;
  }
  if (context.method === "GET" && path === "/v1/windows") {
    context.body = {
      windows: service.queryWindows({
        project_id: context.query.project_id || null,
        actor: context.query.actor || context.get("x-actor") || null,
      }),
    };
    return;
  }

  // ---- 待办、巡检（运维/恢复） ----
  if (context.method === "GET" && path === "/v1/todos") {
    context.body = { todos: service.getTodos() };
    return;
  }
  if (context.method === "POST" && path === "/v1/tick") {
    const actions = service.tick(body.at);
    context.body = { actions };
    return;
  }

  context.status = 404;
  context.body = { code: "not_found" };
}

function withOperator(context, body) {
  return { ...body, operator: body.operator || context.get("x-actor") || undefined };
}
