import assert from "node:assert/strict";
import test from "node:test";
import { startServer, setupTwoLabScenario } from "./helpers.js";

test("已发布结论不被覆盖：迟到复测产生替代版草案，确认后才替换", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15);
  const b = await scene.resultB(14);
  const key = a.clusterKey;
  const confirm = await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });
  assert.equal(confirm.body.observation.category, "consistent");

  // 迟到复测：B 实验室对自己的 B 管重新检测，结果转阴，触发重评。
  await request("POST", "/v1/retests", {
    labId: "LAB-B",
    batchId: scene.ids.batchB,
    tubeId: scene.ids.tubeB.tubeId,
    sampleId: scene.ids.sampleId,
    target: "SPECIES_X",
    methodId: scene.ids.methodId,
    methodVersion: "1.0",
    value: 2,
    measuredAt: scene.ISO(16),
    operator: "tech-LAB-B",
    qc: { controlPassed: true },
    retestOfResultId: b.result.resultId,
  });

  const concl = (await request("GET", `/v1/conclusions/${key}`)).body.conclusion;
  const versions = concl.versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[0].status, "published");
  assert.equal(versions[0].category, "consistent");
  assert.equal(versions[1].status, "draft");
  assert.equal(versions[1].category, "conflict");
  assert.equal(versions[1].supersedesVersion, 1);

  // 替代版确认前，对外观测仍是已发布版
  let obs = (await request("GET", "/v1/observations")).body.observations;
  assert.equal(obs[0].category, "consistent");
  assert.equal(obs[0].version, 1);

  await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-wang" });
  obs = (await request("GET", "/v1/observations")).body.observations;
  assert.equal(obs[0].category, "conflict");
  assert.equal(obs[0].version, 2);
});

test("方法更正只重评未发布草案；已发布结论另起替代版", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(11, { thresholds: { positiveAt: 10 } });
  const b = await scene.resultB(11, { thresholds: { positiveAt: 10 } });
  const key = a.clusterKey;
  // 草案 consistent，尚未发布
  await request("POST", "/v1/methods/corrections", {
    methodId: scene.ids.methodId, version: "1.1", operator: "qa",
    thresholds: { positiveAt: 20 },
  });
  let concl = (await request("GET", `/v1/conclusions/${key}`)).body.conclusion;
  assert.equal(concl.versions.length, 1, "未发布草案就地重评，不产生新版本");
  // 旧结果（按 1.0 判阳）在新方法版本下被标记为方法过期 → needs_retest
  assert.equal(concl.versions[0].category, "needs_retest");

  // 用新方法版本复测达到一致并发布
  await request("POST", "/v1/retests", {
    labId: "LAB-A", batchId: scene.ids.batchA, tubeId: scene.ids.tubeA.tubeId,
    sampleId: scene.ids.sampleId, target: "SPECIES_X",
    methodId: scene.ids.methodId, methodVersion: "1.1", value: 25,
    measuredAt: scene.ISO(17), operator: "ta",
    qc: { controlPassed: true }, retestOfResultId: a.result.resultId,
  });
  // 仍只有一家使用新版本，保持 needs_retest；再补 B
  await request("POST", "/v1/retests", {
    labId: "LAB-B", batchId: scene.ids.batchB, tubeId: scene.ids.tubeB.tubeId,
    sampleId: scene.ids.sampleId, target: "SPECIES_X",
    methodId: scene.ids.methodId, methodVersion: "1.1", value: 24,
    measuredAt: scene.ISO(17), operator: "tb",
    qc: { controlPassed: true }, retestOfResultId: b.result.resultId,
  });
  concl = (await request("GET", `/v1/conclusions/${key}`)).body.conclusion;
  const draft = concl.versions.find((v) => v.status === "draft");
  assert.equal(draft.category, "consistent");
  await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });

  // 再次更正方法（3.0），已发布结论应另起替代版
  await request("POST", "/v1/methods/corrections", {
    methodId: scene.ids.methodId, version: "3.0", operator: "qa",
    thresholds: { positiveAt: 100 },
  });
  concl = (await request("GET", `/v1/conclusions/${key}`)).body.conclusion;
  assert.ok(concl.versions.some((v) => v.status === "draft" && v.supersedesVersion));
});

test("交接发出后未确认，超时进入待办；确认后关闭", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  // scene 已确认两管交接，故无超期。这里新造一管并只发出不确认。
  const extra = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: scene.ids.sampleId, type: "aliquoted",
    occurredAt: scene.ISO(8, 6), operator: "alice",
    data: { tubes: [{ sealId: "SEAL-C", volumeMl: 20 }] },
  }).then((r) => r.body.event.data.tubes[0]);
  const sent = await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: extra.tubeId, type: "handed_over",
    occurredAt: scene.ISO(8, 11), operator: "alice", sealId: "SEAL-C",
    data: { stage: "sent", to: "LAB-A" },
  }).then((r) => r.body.event);

  const todos = (await request("GET", "/v1/todos")).body.todos;
  const ho = todos.find((todo) => todo.kind === "handover_timeout");
  assert.ok(ho);
  assert.equal(ho.handoverId, sent.data.handoverId);
  // 恢复接口汇总超时交接
  const rec = await request("GET", "/v1/recovery");
  assert.ok(rec.body.overdueHandovers.some((todo) => todo.handoverId === sent.data.handoverId));

  // 确认后关闭
  await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: extra.tubeId, type: "handed_over",
    occurredAt: scene.ISO(12), operator: "bob",
    data: { stage: "confirmed", handoverId: sent.data.handoverId, receiver: "bob" },
  });
  const after = (await request("GET", "/v1/todos")).body.todos;
  assert.ok(!after.some((todo) => todo.handoverId === sent.data.handoverId));
});

test("溯源查询可从结论追回样本、保管断点、质控证据与批准人", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, { tempB: { maxC: 11 } });
  const a = await scene.resultA(15, { uncertainty: { value: 0.3, unit: "x" } });
  await scene.resultB(3);
  const key = a.clusterKey;
  await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });

  const trace = (await request("GET", `/v1/conclusions/${key}/trace`)).body;
  assert.equal(trace.samples.length, 1);
  assert.equal(trace.samples[0].sampleId, scene.ids.sampleId);
  assert.equal(trace.tubes.length, 2);
  assert.ok(trace.batches.some((b) => b.labId === "LAB-A"));
  assert.equal(trace.evidence.length, 2);
  assert.equal(trace.evidence[0].method.usedVersion, "1.0");
  assert.equal(trace.evidence[0].uncertainty.value, 0.3);
  assert.ok(trace.chain.breaks.some((b) => b.type === "temperature_above_range"));
  assert.ok(trace.chain.events.length >= 2);
  assert.equal(trace.observation.approver, "dr-li");
  assert.ok(trace.observation.observationId);
});

test("崩溃恢复：重启后从哈希链日志重建全部状态与待办", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wom-restart-"));
  const journalFile = join(dir, "chain.journal.jsonl");
  t.after(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await startServer({ journalFile });
  const { request, close } = first;
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15);
  await scene.resultB(14);
  const key = a.clusterKey;
  await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });

  // 再造一个只发出未确认的交接，验证超时待办跨重启
  const extra = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: scene.ids.sampleId, type: "aliquoted",
    occurredAt: scene.ISO(8, 7), operator: "alice",
    data: { tubes: [{ sealId: "SEAL-R", volumeMl: 10 }] },
  }).then((r) => r.body.event.data.tubes[0]);
  await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: extra.tubeId, type: "handed_over",
    occurredAt: scene.ISO(8, 12), operator: "alice", sealId: "SEAL-R",
    data: { stage: "sent", to: "LAB-A" },
  });
  await close(); // 模拟进程退出（日志文件保留）

  // 用同一日志文件重启
  const { MergerService } = await import("../src/domain/merger.js");
  const service = new MergerService({ journalFile });
  const recovery = service.recover();
  assert.ok(recovery.journalSeq > 5);
  assert.equal(service.store.samples.get(scene.ids.sampleId).status, "collected");
  assert.ok(service.store.tubes.has(scene.ids.tubeA.tubeId));

  const stored = service.getConclusion(key);
  const published = stored.conclusion.versions.find((v) => v.status === "published");
  assert.equal(published.confirmedBy, "dr-li");

  const obs = service.listObservations().observations;
  assert.equal(obs.length, 1);
  // 超时交接待办被恢复
  assert.ok(service.listTodos().todos.some((todo) => todo.sealId === "SEAL-R"));
  assert.ok(recovery.overdueHandovers.some((todo) => todo.sealId === "SEAL-R"));
});
