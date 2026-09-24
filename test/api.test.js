import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/eventlog.js";
import { CustodyService } from "../src/custody.js";
import { buildApp } from "../src/app.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "wetland-api-"));
  const clock = () => "2026-09-20T00:00:00.000Z";
  const log = new EventLog({ dir, clock });
  const service = new CustodyService(log, { clock });
  service.load();
  const app = buildApp({ service });
  const server = app.listen(0, "127.0.0.1");
  const ready = new Promise((resolve) => server.once("listening", resolve));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return {
    service,
    ready,
    base,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          rmSync(dir, { recursive: true, force: true });
          error ? reject(error) : resolve();
        });
      }),
  };
}

async function json(http, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${http.base()}${path}`, init);
  let parsed = null;
  const text = await response.text();
  if (text) parsed = JSON.parse(text);
  return { status: response.status, body: parsed };
}

test("HTTP：完整流程采集到确认发布，并在窗口中按权限降精度", async () => {
  const http = harness();
  try {
    await http.ready;
    const policy = await json(http, "POST", "/v1/projects/P1/policy", {
      sensitive_species: ["OTTER_DNA"],
      members: [
        { actor: "pi-lee", role: "pi" },
        { actor: "vol-ann", role: "volunteer" },
      ],
      precision_by_role: { pi: "exact", volunteer: "grid" },
      default_precision: "withhold",
    }, { "x-actor": "admin" });
    assert.equal(policy.status, 204);

    const sample = await json(http, "POST", "/v1/samples", {
      project_id: "P1",
      collector: "field-bob",
      site: { site_id: "SITE-7" },
      temp: { min_c: 3, max_c: 7 },
    });
    assert.equal(sample.status, 201);
    const sampleId = sample.body.sample_id;

    const aliquot = await json(http, "POST", `/v1/samples/${sampleId}/aliquots`, {
      prepared_by: "field-bob",
      seal_id: "SEAL-1",
      tube_barcode: "TUBE-1",
      destination_lab: "lab-a",
    });
    const aliquotId = aliquot.body.aliquot_id;

    const handover = await json(http, "POST", `/v1/aliquots/${aliquotId}/handovers`, {
      shipped_by: "field-bob",
      seal_id: "SEAL-1",
      expected_receiver: "lab-a",
    });
    const handoverId = handover.body.handover_id;

    const accepted = await json(http, "POST", `/v1/handovers/${handoverId}/accept`, {
      receiver: "lab-a",
      seal_intact: true,
      temp: { min_c: 3, max_c: 7 },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.breaks, []);

    const batch = await json(http, "POST", "/v1/batches", { lab: "lab-a", aliquot_ids: [aliquotId] });
    const result = await json(http, "POST", `/v1/batches/${batch.body.batch_id}/results`, {
      aliquot_id: aliquotId,
      analyte: "OTTER_DNA",
      method: { id: "edna-qpcr", version: "1.4.2" },
      threshold: { analyte: "OTTER_DNA", cutoff: 30, comparator: "gte" },
      value: 45,
      unit: "copies/uL",
      uncertainty: { value: 2, k: 2 },
      qc: [{ type: "blank", passed: true }],
      analyst: "lab-a",
    });
    assert.equal(result.body.result.call, "positive");

    const evaluation = await json(http, "POST", `/v1/samples/${sampleId}/conclusions/OTTER_DNA/evaluate`, {});
    assert.equal(evaluation.body.conclusion.decision, "consistent");
    const conclusionId = evaluation.body.conclusion.conclusion_id;

    const window = await json(http, "POST", "/v1/windows", {
      project_id: "P1",
      species_code: "OTTER_DNA",
      start_at: "2026-09-01T00:00:00Z",
      end_at: "2026-09-30T00:00:00Z",
      location: { lat: 30.123456, lng: 120.56789 },
    });
    const windowId = window.body.window_id;

    const confirm = await json(http, "POST", `/v1/conclusions/${conclusionId}/confirm`, {
      reviewer: "pi-lee",
      window_id: windowId,
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.conclusion.status, "confirmed");

    const piView = await json(http, "GET", "/v1/windows?project_id=P1&actor=pi-lee");
    assert.equal(piView.body.windows[0].location_precision, "exact");
    assert.equal(piView.body.windows[0].published_links[0].approved_by, "pi-lee");

    const volView = await json(http, "GET", "/v1/windows?project_id=P1&actor=vol-ann");
    assert.equal(volView.body.windows[0].location_precision, "grid");
    assert.notDeepEqual(volView.body.windows[0].location, { lat: 30.123456, lng: 120.56789 });

    const outsider = await json(http, "GET", "/v1/windows?project_id=P1&actor=stranger");
    assert.equal(outsider.body.windows[0].location, null);

    const trace = await json(http, "GET", `/v1/conclusions/${conclusionId}/trace`);
    assert.equal(trace.body.sample.id, sampleId);
    assert.equal(trace.body.qc_evidence[0].control.type, "blank");
    assert.equal(trace.body.approvals[0].reviewer, "pi-lee");
    assert.equal(trace.body.lineage[0].events.at(-1).type, "TESTED");
  } finally {
    await http.close();
  }
});

test("HTTP：两个接收方并发确认同一封签，恰好一个成功", async () => {
  const http = harness();
  try {
    await http.ready;
    const sample = await json(http, "POST", "/v1/samples", {
      collector: "bob",
      site: { site_id: "X" },
      temp: { min_c: 3, max_c: 7 },
    });
    const aliquot = await json(http, "POST", `/v1/samples/${sample.body.sample_id}/aliquots`, {
      prepared_by: "bob",
      seal_id: "SEAL-X",
      destination_lab: "lab-a",
    });
    const handover = await json(http, "POST", `/v1/aliquots/${aliquot.body.aliquot_id}/handovers`, {
      shipped_by: "bob",
      seal_id: "SEAL-X",
      expected_receiver: "lab-a",
    });
    const handoverId = handover.body.handover_id;

    const [first, second] = await Promise.all([
      json(http, "POST", `/v1/handovers/${handoverId}/accept`, { receiver: "lab-a", temp: { min_c: 3, max_c: 7 } }),
      json(http, "POST", `/v1/handovers/${handoverId}/accept`, { receiver: "lab-a", temp: { min_c: 3, max_c: 7 } }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const conflict = [first, second].find((r) => r.status === 409);
    assert.equal(conflict.body.code, "seal_already_confirmed");

    // 非指定接收方扫码始终被拒。
    const wrong = await json(http, "POST", `/v1/handovers/${handoverId}/accept`, { receiver: "lab-b", temp: { min_c: 3, max_c: 7 } });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, "wrong_receiver");
  } finally {
    await http.close();
  }
});

test("HTTP：Idempotency-Key 重复提交返回同一事件且不产生重复数据", async () => {
  const http = harness();
  try {
    await http.ready;
    const payload = {
      collector: "bob",
      site: { site_id: "X" },
      temp: { min_c: 3, max_c: 7 },
      scan_nonce: "scan-77",
    };
    const first = await json(http, "POST", "/v1/samples", payload, { "idempotency-key": "req-77" });
    const second = await json(http, "POST", "/v1/samples", payload, { "idempotency-key": "req-77" });
    assert.equal(first.status, 201);
    assert.equal(second.body.event_id, first.body.event_id);
    assert.equal(second.body.duplicated, true);
    assert.equal(http.service.samples.size, 1);
  } finally {
    await http.close();
  }
});

test("HTTP：缺操作者、错误状态、未知资源返回结构化错误", async () => {
  const http = harness();
  try {
    await http.ready;
    const noOperator = await json(http, "POST", "/v1/samples", { site: { site_id: "X" }, temp: { min_c: 3, max_c: 7 } });
    assert.equal(noOperator.status, 400);
    assert.equal(noOperator.body.code, "operator_required");

    const missingSample = await json(http, "POST", "/v1/samples/NOPE/aliquots", {
      prepared_by: "bob",
      seal_id: "S1",
    });
    assert.equal(missingSample.status, 404);
    assert.equal(missingSample.body.code, "sample_not_found");

    const notFound = await json(http, "GET", "/v1/nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.code, "not_found");
  } finally {
    await http.close();
  }
});

test("HTTP：待办接口列出在途交接与待复测结论", async () => {
  const http = harness();
  try {
    await http.ready;
    const sample = await json(http, "POST", "/v1/samples", {
      collector: "bob",
      site: { site_id: "X" },
      temp: { min_c: 3, max_c: 7 },
    });
    const aliquot = await json(http, "POST", `/v1/samples/${sample.body.sample_id}/aliquots`, {
      prepared_by: "bob",
      seal_id: "S1",
      destination_lab: "lab-a",
    });
    await json(http, "POST", `/v1/aliquots/${aliquot.body.aliquot_id}/handovers`, {
      shipped_by: "bob",
      seal_id: "S1",
    });
    const todos = await json(http, "GET", "/v1/todos");
    assert.equal(todos.status, 200);
    assert.equal(todos.body.todos[0].type, "handover_acceptance");
  } finally {
    await http.close();
  }
});
