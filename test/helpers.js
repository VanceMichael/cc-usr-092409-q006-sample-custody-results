import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

/** 启动一个监听随机端口的应用，返回 http 客户端与关闭函数。 */
export async function startServer({ journal = "memory", journalFile: explicitFile, sweep = false } = {}) {
  let journalFile;
  let tempDir;
  if (explicitFile) {
    journalFile = explicitFile;
  } else if (journal === "file") {
    tempDir = mkdtempSync(join(tmpdir(), "wom-"));
    journalFile = join(tempDir, "chain.journal.jsonl");
  } else {
    journalFile = undefined;
  }
  const app = buildApp({ journalFile, sweep });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function request(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${path}`, init);
    let payload = null;
    const text = await response.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    return { status: response.status, body: payload, headers: response.headers };
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (app.sweepTimer) clearInterval(app.sweepTimer);
    // undici 默认 keep-alive，不断开连接 server.close 回调会一直等待。
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  return { request, close, journalFile, tempDir: () => tempDir, service: app.context.merger };
}

const ISO = (h, m = 0) => `2026-09-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`;

/**
 * 构造“同一样本分装两管、两家实验室各持一管”的标准场景。
 * opts.handover: { a: confirmData, b: confirmData } 覆盖交接确认；
 * opts.tempA/tempB 给发出交接附温控摘要；opts.target 决定敏感性。
 */
export async function setupTwoLabScenario(request, opts = {}) {
  const sample = await request("POST", "/v1/samples", {
    siteId: opts.siteId ?? "W-01",
    collectedAt: ISO(8),
    operator: "alice",
    location: { lat: 30.123456, lng: 120.123456 },
  }).then((r) => r.body.sample);

  const method = await request("POST", "/v1/methods", {
    methodId: "M-PCR",
    code: "PCR",
    thresholds: { positiveAt: 10 },
  }).then((r) => r.body.method);

  const batchA = await request("POST", "/v1/batches", { labId: "LAB-A", methodId: method.methodId })
    .then((r) => r.body.batch.batchId);
  const batchB = await request("POST", "/v1/batches", { labId: "LAB-B", methodId: method.methodId })
    .then((r) => r.body.batch.batchId);

  const aliquot = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: sample.sampleId, type: "aliquoted",
    occurredAt: ISO(8, 5), operator: "alice",
    data: { tubes: [{ sealId: "SEAL-A", volumeMl: 50 }, { sealId: "SEAL-B", volumeMl: 50 }] },
  }).then((r) => r.body.event.data.tubes);
  const [tubeA, tubeB] = aliquot;

  async function sendAndConfirm(tube, seal, to, receiver, h, temp) {
    const sent = await request("POST", "/v1/chain/events", {
      resourceKind: "tube", resourceId: tube.tubeId, type: "handed_over",
      occurredAt: ISO(8, 10), operator: "alice", sealId: seal,
      temperature: temp ?? null,
      data: { stage: "sent", to },
    }).then((r) => r.body.event);
    const confirmed = await request("POST", "/v1/chain/events", {
      resourceKind: "tube", resourceId: tube.tubeId, type: "handed_over",
      occurredAt: ISO(11), operator: receiver,
      data: { stage: "confirmed", handoverId: sent.data.handoverId, receiver, ...h },
    });
    return { sent, confirmed: confirmed.body, handoverId: sent.data.handoverId };
  }

  const a = await sendAndConfirm(tubeA, "SEAL-A", "LAB-A", "bob", opts.confirmA ?? { sealIntact: true }, opts.tempA);
  const b = await sendAndConfirm(tubeB, "SEAL-B", "LAB-B", "tom", opts.confirmB ?? { sealIntact: true }, opts.tempB);

  async function result(labId, batchId, tube, value, extra = {}) {
    const res = await request("POST", "/v1/results", {
      labId, batchId, tubeId: tube.tubeId, sampleId: sample.sampleId,
      target: opts.target ?? "SPECIES_X",
      methodId: method.methodId, methodVersion: "1.0",
      value, measuredAt: ISO(13), operator: `tech-${labId}`,
      qc: { controlPassed: true }, ...extra,
    });
    return res.body;
  }

  return {
    ids: { sampleId: sample.sampleId, methodId: method.methodId, batchA, batchB, tubeA, tubeB },
    handovers: { a: a.handoverId, b: b.handoverId },
    resultA: (value, extra) => result("LAB-A", batchA, tubeA, value, extra),
    resultB: (value, extra) => result("LAB-B", batchB, tubeB, value, extra),
    ISO,
  };
}

