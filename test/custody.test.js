import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/eventlog.js";
import { CustodyService } from "../src/custody.js";
import { ChainIntegrityError } from "../src/errors.js";
import { evaluateConclusion, reducePrecision } from "../src/policy.js";

function makeService(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wetland-"));
  let now = options.start ?? "2026-09-20T00:00:00.000Z";
  const clock = () => now;
  const log = new EventLog({ dir, clock });
  const service = new CustodyService(log, { clock, handoverTimeoutMs: options.handoverTimeoutMs ?? 3_600_000, retestDueMs: options.retestDueMs ?? 86_400_000 });
  service.load();
  return {
    dir,
    service,
    setTime: (iso) => {
      now = iso;
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const METHOD = { id: "edna-qpcr", version: "1.4.2" };
const THRESHOLD = { analyte: "OTTER_DNA", cutoff: 30, comparator: "gte" };
const TEMP_OK = { min_c: 3, max_c: 7 };

function setupSample(service, { sealId = "SEAL-1", lab = "lab-a", receiver = "lab-a", temp = TEMP_OK, sealIntact = true, offline = false } = {}) {
  const collected = service.collectSample({
    project_id: "P1",
    collector: "field-bob",
    site: { site_id: "SITE-7", lat: 30.1234, lng: 120.5678 },
    temp,
  });
  const aliquot = service.prepareAliquot(collected.sample.id, {
    prepared_by: "field-bob",
    seal_id: sealId,
    tube_barcode: "TUBE-1",
    destination_lab: lab,
  });
  const handover = service.openHandover(aliquot.aliquot.id, {
    shipped_by: "field-bob",
    seal_id: sealId,
    expected_receiver: receiver,
  });
  const accepted = service.acceptHandover(handover.handover_id, {
    receiver,
    seal_intact: sealIntact,
    temp,
    offline,
  });
  return { sampleId: collected.sample.id, aliquotId: aliquot.aliquot.id, handoverId: handover.handover_id, accepted };
}

function recordPositive(service, aliquotId, overrides = {}) {
  const batch = service.registerBatch({ lab: overrides.lab ?? "lab-a", aliquot_ids: [aliquotId] });
  return service.recordResult(batch.batch.id, {
    aliquot_id: aliquotId,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 45,
    unit: "copies/uL",
    uncertainty: { value: 2, k: 2 },
    qc: [{ type: "blank", passed: true }],
    ...overrides,
  });
}

test("采集到销毁建立样本与分装管谱系，事件含操作者/时间/温控/指纹", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);

  const aliquot = service.aliquots.get(aliquotId);
  const types = aliquot.events.map((e) => e.type);
  assert.deepEqual(types, ["ALIQUOT_PREPARED", "HANDOVER_OPENED", "HANDOVER_ACCEPTED"]);
  const accept = aliquot.events.find((e) => e.type === "HANDOVER_ACCEPTED");
  assert.equal(accept.operator, "lab-a");
  assert.ok(accept.occurred_at);
  assert.deepEqual(accept.temp, TEMP_OK);
  assert.ok(accept.content_digest, "事件必须带内容指纹");
  assert.ok(accept.hash, "事件必须带链哈希");
  assert.equal(accept.prev_hash.length, 64);

  service.store(aliquotId, { operator: "lab-a", location: "FRIDGE-2", temp: TEMP_OK });
  service.open(aliquotId, { operator: "lab-a", purpose: "extract" });
  service.destroyAliquot(aliquotId, { operator: "lab-a", method: "autoclave" });
  service.destroySample(sampleId, { operator: "lab-a", method: "incineration" });
  assert.equal(service.aliquots.get(aliquotId).state, "destroyed");
  assert.equal(service.samples.get(sampleId).state, "destroyed");
  dispose();
});

test("重复扫码与重复请求幂等，只产生一个事件", () => {
  const harness = makeService();
  const { service, dispose } = harness;

  const first = service.collectSample({
    request_id: "req-1",
    scan_nonce: "scan-1",
    collector: "field-bob",
    site: { site_id: "SITE-7" },
    temp: TEMP_OK,
  });
  assert.equal(first.duplicated, false);

  const retry = service.collectSample({
    request_id: "req-1",
    scan_nonce: "scan-1",
    collector: "field-bob",
    site: { site_id: "SITE-7" },
    temp: TEMP_OK,
  });
  assert.equal(retry.duplicated, true);
  assert.equal(retry.event.event_id, first.event.event_id);

  // 即使换了请求号，同一物理扫码动作（scan_nonce）仍只接受一次。
  const anotherKey = service.collectSample({
    request_id: "req-2",
    scan_nonce: "scan-1",
    collector: "field-bob",
    site: { site_id: "SITE-7" },
    temp: TEMP_OK,
  });
  assert.equal(anotherKey.duplicated, true);
  assert.equal(anotherKey.event.event_id, first.event.event_id);
  dispose();
});

test("同一封签两个接收方并发确认，只有一个成功", async () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { aliquotId } = setupSample(service, { receiver: "lab-a", sealId: "SEAL-9" });
  // 另起一个在途交接用于并发确认竞争。
  const aliquot2 = service.prepareAliquot(service.aliquots.get(aliquotId).sample_id, {
    prepared_by: "field-bob",
    seal_id: "SEAL-10",
    tube_barcode: "TUBE-2",
    destination_lab: "lab-b",
  });
  const h = service.openHandover(aliquot2.aliquot.id, { shipped_by: "field-bob", seal_id: "SEAL-10", expected_receiver: "lab-b" });

  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => service.acceptHandover(h.handover_id, { receiver: "lab-b", temp: TEMP_OK })),
    Promise.resolve().then(() => service.acceptHandover(h.handover_id, { receiver: "lab-b", temp: TEMP_OK })),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(fulfilled.length, 1, "恰好一个确认成功");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "seal_already_confirmed");
  assert.equal(service.aliquots.get(aliquot2.aliquot.id).handovers[0].receiver, "lab-b");

  // 非指定接收方即使唯一确认也会被拒。
  assert.throws(
    () => service.acceptHandover(h.handover_id, { receiver: "lab-c", temp: TEMP_OK }),
    (error) => error.code === "wrong_receiver",
  );
  dispose();
});

test("离线补报事件越过已签节点进入待裁定，认可后解除、驳回记为断点", () => {
  const harness = makeService();
  const { service, dispose, setTime } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const aliquot = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "S1", destination_lab: "lab-a" });
  const handover = service.openHandover(aliquot.aliquot.id, { shipped_by: "bob", seal_id: "S1", expected_receiver: "lab-a", occurred_at: "2026-09-20T08:30:00.000Z" });

  // 在线先签收（已签节点在 09:00）。
  setTime("2026-09-20T09:00:00.000Z");
  service.acceptHandover(handover.handover_id, { receiver: "lab-a", temp: TEMP_OK, occurred_at: "2026-09-20T09:00:00.000Z" });

  // 离线补报一个发生在 08:00（早于已签节点）的入库 → 越序待裁定。
  const lateStore = service.store(aliquot.aliquot.id, {
    operator: "lab-a",
    location: "FR-1",
    temp: TEMP_OK,
    offline: true,
    occurred_at: "2026-09-20T08:00:00.000Z",
  });
  assert.equal(lateStore.event.offline, true);

  const pending = service.aliquots.get(aliquot.aliquot.id).events.filter((e) => e.payload?.requires_adjudication);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.out_of_order, true);

  // 待裁定期间结论不能直接判定，应为 needs_retest。
  const batch = service.registerBatch({ lab: "lab-a", aliquot_ids: [aliquot.aliquot.id] });
  service.recordResult(batch.batch.id, {
    aliquot_id: aliquot.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 45,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [],
  });
  let conclusion = service.evaluate(collected.sample.id, "OTTER_DNA");
  assert.equal(conclusion.decision, "needs_retest");

  // 审核驳回离线事件 → 保管断点，仍需复测。
  service.adjudicate(aliquot.aliquot.id, { reviewer: "pi-lee", event_id: pending[0].event_id, verdict: "reject" });
  conclusion = service.evaluate(collected.sample.id, "OTTER_DNA");
  assert.equal(conclusion.decision, "needs_retest");
  const trace = service.trace(conclusion.id);
  assert.ok(trace.adjudication_pending.length === 0);
  assert.ok(trace.custody_breaks.some((b) => b.type === "offline_event_rejected"));
  dispose();
});

test("离线事件经审核认可后不构成断点，结果可判一致", () => {
  const harness = makeService();
  const { service, dispose, setTime } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const aliquot = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "S1", destination_lab: "lab-a" });
  const handover = service.openHandover(aliquot.aliquot.id, { shipped_by: "bob", seal_id: "S1", expected_receiver: "lab-a", occurred_at: "2026-09-20T08:30:00.000Z" });
  setTime("2026-09-20T09:00:00.000Z");
  service.acceptHandover(handover.handover_id, { receiver: "lab-a", temp: TEMP_OK, occurred_at: "2026-09-20T09:00:00.000Z" });
  const lateStore = service.store(aliquot.aliquot.id, {
    operator: "lab-a",
    location: "FR-1",
    temp: TEMP_OK,
    offline: true,
    occurred_at: "2026-09-20T08:00:00.000Z",
  });
  service.adjudicate(aliquot.aliquot.id, { reviewer: "pi-lee", event_id: lateStore.event.event_id, verdict: "accept" });
  const batch = service.registerBatch({ lab: "lab-a", aliquot_ids: [aliquot.aliquot.id] });
  service.recordResult(batch.batch.id, {
    aliquot_id: aliquot.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 45,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [],
  });
  const conclusion = service.evaluate(collected.sample.id, "OTTER_DNA");
  assert.equal(conclusion.decision, "consistent");
  dispose();
});

test("封签确认的请求重试幂等与他人重复确认冲突", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const tube = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "S1", destination_lab: "lab-a" });
  const handover = service.openHandover(tube.aliquot.id, { shipped_by: "bob", seal_id: "S1", expected_receiver: "lab-a" });

  const first = service.acceptHandover(handover.handover_id, { request_id: "acc-1", scan_nonce: "scan-acc-1", receiver: "lab-a", temp: TEMP_OK });
  assert.equal(first.duplicated, false);
  const retry = service.acceptHandover(handover.handover_id, { request_id: "acc-1", scan_nonce: "scan-acc-1", receiver: "lab-a", temp: TEMP_OK });
  assert.equal(retry.duplicated, true);
  assert.equal(retry.event.event_id, first.event.event_id);
  assert.throws(
    () => service.acceptHandover(handover.handover_id, { request_id: "acc-2", receiver: "lab-a", temp: TEMP_OK }),
    (error) => error.code === "seal_already_confirmed",
  );
  dispose();
});

test("冷链中断判为待复测；封签破损或空白对照检出判为疑似污染", () => {
  // 冷链超温
  const h1 = makeService();
  const { service: s1, dispose: d1 } = h1;
  const r1 = setupSample(s1, { temp: { min_c: 3, max_c: 14 } });
  recordPositive(s1, r1.aliquotId);
  const c1 = s1.evaluate(r1.sampleId, "OTTER_DNA");
  assert.equal(c1.decision, "needs_retest");
  assert.ok(c1.evaluation.reasons.some((x) => x.code === "temperature_excursion"));
  d1();

  // 封签破损
  const h2 = makeService();
  const { service: s2, dispose: d2 } = h2;
  const r2 = setupSample(s2, { sealIntact: false });
  recordPositive(s2, r2.aliquotId);
  const c2 = s2.evaluate(r2.sampleId, "OTTER_DNA");
  assert.equal(c2.decision, "suspected_contamination");
  assert.ok(c2.evaluation.reasons.some((x) => x.code === "seal_compromised"));
  d2();

  // 空白对照阳性（污染性质控失败）
  const h3 = makeService();
  const { service: s3, dispose: d3 } = h3;
  const r3 = setupSample(s3);
  recordPositive(s3, r3.aliquotId, { qc: [{ type: "blank", passed: false, detail: "detected in extraction blank" }] });
  const c3 = s3.evaluate(r3.sampleId, "OTTER_DNA");
  assert.equal(c3.decision, "suspected_contamination");
  assert.ok(c3.evaluation.reasons.some((x) => x.code === "contaminative_qc_failure"));
  d3();
});

test("两家实验室一阳一阴判冲突", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });

  const tubeA = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "SA", tube_barcode: "TA", destination_lab: "lab-a" });
  const hA = service.openHandover(tubeA.aliquot.id, { shipped_by: "bob", seal_id: "SA", expected_receiver: "lab-a" });
  service.acceptHandover(hA.handover_id, { receiver: "lab-a", temp: TEMP_OK });
  const tubeB = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "SB", tube_barcode: "TB", destination_lab: "lab-b" });
  const hB = service.openHandover(tubeB.aliquot.id, { shipped_by: "bob", seal_id: "SB", expected_receiver: "lab-b" });
  service.acceptHandover(hB.handover_id, { receiver: "lab-b", temp: TEMP_OK });

  const batchA = service.registerBatch({ lab: "lab-a", aliquot_ids: [tubeA.aliquot.id] });
  service.recordResult(batchA.batch.id, {
    aliquot_id: tubeA.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 45,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [],
  });
  const batchB = service.registerBatch({ lab: "lab-b", aliquot_ids: [tubeB.aliquot.id] });
  service.recordResult(batchB.batch.id, {
    aliquot_id: tubeB.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 5,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [],
  });
  const conclusion = service.evaluate(collected.sample.id, "OTTER_DNA");
  assert.equal(conclusion.decision, "conflict");
  assert.ok(conclusion.evaluation.reasons.some((x) => x.code === "qualitative_disagreement"));
  dispose();
});

test("数值差在合成不确定度内判一致，超出判冲突", () => {
  // 45 ±4 与 48 ±4，差距 3 < 8 → 一致
  const result = evaluateConclusion(
    [
      { result_id: "r1", value: 45, unit: "u", threshold: THRESHOLD, uncertainty: { value: 2, k: 2 }, qc: [] },
      { result_id: "r2", value: 48, unit: "u", threshold: THRESHOLD, uncertainty: { value: 2, k: 2 }, qc: [] },
    ],
    {},
  );
  assert.equal(result.decision, "consistent");

  const conflict = evaluateConclusion(
    [
      { result_id: "r1", value: 45, unit: "u", threshold: THRESHOLD, uncertainty: { value: 0.5, k: 2 }, qc: [] },
      { result_id: "r2", value: 60, unit: "u", threshold: THRESHOLD, uncertainty: { value: 0.5, k: 2 }, qc: [] },
    ],
    {},
  );
  assert.equal(conflict.decision, "conflict");
});

test("结果落在阈值不确定度带内判待复测", () => {
  const result = evaluateConclusion(
    [{ result_id: "r1", value: 31, unit: "u", threshold: THRESHOLD, uncertainty: { value: 2, k: 2 }, qc: [] }],
    {},
  );
  assert.equal(result.decision, "needs_retest");
  assert.ok(result.reasons.some((x) => x.code === "within_uncertainty_band"));
});

test("方法更正只重评未发布结论；已发布结论产生替代版并需重新确认", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);
  const recorded = recordPositive(service, aliquotId);
  let conclusion = service.evaluate(sampleId, "OTTER_DNA");
  assert.equal(conclusion.decision, "consistent");
  assert.equal(conclusion.version, 1);

  const window = service.registerWindow({
    project_id: "P1",
    species_code: "OTTER_DNA",
    start_at: "2026-09-01",
    end_at: "2026-09-30",
    location: { lat: 30.123, lng: 120.456 },
  });
  service.confirmConclusion(conclusion.id, { reviewer: "pi-lee", window_id: window.id });
  assert.equal(service.conclusions.get(conclusion.id).status, "confirmed");

  // 发布后更正阈值，使结果转阴 → 旧版被替代，新版仍是 proposed。
  service.correctResult(recorded.result.id, {
    corrected_by: "lab-a",
    reason: "阈值配置错误",
    threshold: { analyte: "OTTER_DNA", cutoff: 60, comparator: "gte" },
  });
  const newId = service.conclusionIndex.get(`${sampleId}|OTTER_DNA`);
  const replacement = service.conclusions.get(newId);
  assert.notEqual(newId, conclusion.id);
  assert.equal(replacement.status, "proposed");
  assert.equal(replacement.supersedes, conclusion.id);
  assert.equal(service.conclusions.get(conclusion.id).status, "superseded");
  assert.equal(service.conclusions.get(conclusion.id).superseded_by, newId);
  // 旧的已发布关联仍在（不回写历史）。
  assert.equal(service.windows.get(window.id).linked.length, 1);

  // 替代版确认后才产生第二条发布关联。
  service.confirmConclusion(newId, { reviewer: "pi-lee", window_id: window.id });
  assert.equal(service.windows.get(window.id).linked.length, 2);
  dispose();
});

test("迟到复测到达后重评未发布结论", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const tube = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "SA", destination_lab: "lab-a" });
  const ho = service.openHandover(tube.aliquot.id, { shipped_by: "bob", seal_id: "SA", expected_receiver: "lab-a" });
  service.acceptHandover(ho.handover_id, { receiver: "lab-a", temp: TEMP_OK });
  const batch = service.registerBatch({ lab: "lab-a", aliquot_ids: [tube.aliquot.id] });
  const first = service.recordResult(batch.batch.id, {
    aliquot_id: tube.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 45,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [{ type: "positive_control", passed: false }],
  });
  let conclusion = service.evaluate(collected.sample.id, "OTTER_DNA");
  assert.equal(conclusion.decision, "needs_retest");

  // 迟到的复测结果（标记 retest_of，质控通过）
  service.recordResult(batch.batch.id, {
    aliquot_id: tube.aliquot.id,
    analyte: "OTTER_DNA",
    method: METHOD,
    threshold: THRESHOLD,
    value: 44,
    unit: "u",
    uncertainty: { value: 1, k: 2 },
    qc: [],
    retest_of: first.result.id,
  });
  const current = service.conclusions.get(service.conclusionIndex.get(`${collected.sample.id}|OTTER_DNA`));
  assert.equal(current.status, "proposed", "未发布结论被原地重评而非替代");
  assert.equal(current.decision, "consistent");
  dispose();
});

test("封签撤销立即重评未发布结论", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);
  recordPositive(service, aliquotId);
  let conclusion = service.evaluate(sampleId, "OTTER_DNA");
  assert.equal(conclusion.decision, "consistent");
  service.revokeSeal(aliquotId, { operator: "field-bob", reason: "封签打印错误，重施新签" });
  conclusion = service.evaluate(sampleId, "OTTER_DNA");
  assert.equal(conclusion.decision, "needs_retest");
  assert.ok(conclusion.evaluation.reasons.some((x) => x.code === "seal_revoked"));
  dispose();
});

test("未经研究员确认的结论不进入观测窗口", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);
  recordPositive(service, aliquotId);
  const conclusion = service.evaluate(sampleId, "OTTER_DNA");
  const window = service.registerWindow({
    project_id: "P1",
    species_code: "OTTER_DNA",
    start_at: "2026-09-01",
    end_at: "2026-09-30",
    location: { lat: 30.123, lng: 120.456 },
  });
  assert.throws(
    () => service.confirmConclusion(conclusion.id, { reviewer: "x" }),
    /window_required|观测窗口/,
  );
  assert.equal(service.windows.get(window.id).linked.length, 0);
  dispose();
});

test("敏感物种位置按项目角色降精度，越权查询隐去坐标", () => {
  service_upsert: {
    const harness = makeService();
    const { service, dispose } = harness;
    service.upsertProject("P1", {
      sensitive_species: ["OTTER_DNA"],
      members: [
        { actor: "pi-lee", role: "pi" },
        { actor: "vol-ann", role: "volunteer" },
      ],
      precision_by_role: { pi: "exact", volunteer: "grid" },
      default_precision: "withhold",
    });
    service.registerWindow({
      project_id: "P1",
      species_code: "OTTER_DNA",
      start_at: "2026-09-01",
      end_at: "2026-09-30",
      location: { lat: 30.123456, lng: 120.56789 },
    });

    const piView = service.queryWindows({ project_id: "P1", actor: "pi-lee" })[0];
    assert.equal(piView.location_precision, "exact");
    assert.deepEqual(piView.location, { lat: 30.123456, lng: 120.56789 });

    const volView = service.queryWindows({ project_id: "P1", actor: "vol-ann" })[0];
    assert.equal(volView.location_precision, "grid");
    assert.ok(Math.abs(volView.location.lat - 30.125) < 1e-9);
    assert.ok(volView.location_cell);

    const outsider = service.queryWindows({ project_id: "P1", actor: "stranger" })[0];
    assert.equal(outsider.location_precision, "withhold");
    assert.equal(outsider.location, null);

    // 非敏感物种不受影响
    service.registerWindow({
      project_id: "P1",
      species_code: "EGRET",
      start_at: "2026-09-01",
      end_at: "2026-09-30",
      location: { lat: 30.1, lng: 120.2 },
    });
    const egret = service.queryWindows({ project_id: "P1", actor: "stranger" }).find((w) => w.species_code === "EGRET");
    assert.equal(egret.location_precision, "exact");
    dispose();
    break service_upsert;
  }
});

test("reducePrecision 直接行为：网格/区域/隐去", () => {
  const loc = { lat: 30.123456, lng: 120.56789 };
  assert.equal(reducePrecision(loc, "withhold").location, null);
  const region = reducePrecision(loc, "region", { region_size: 0.5 });
  assert.ok(Math.abs(region.location.lat - 30.25) < 1e-9);
  assert.ok(Math.abs(region.location.lng - 120.75) < 1e-9);
});

test("崩溃恢复：重启后重放重建状态，并补办超时交接与复测待办", () => {
  const harness = makeService({ start: "2026-09-20T00:00:00.000Z", handoverTimeoutMs: 3_600_000, retestDueMs: 86_400_000 });
  const { service, dir, dispose } = harness;
  const collected = service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const tube = service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "S1", destination_lab: "lab-a" });
  const handover = service.openHandover(tube.aliquot.id, { shipped_by: "bob", seal_id: "S1", expected_receiver: "lab-a" });

  // 模拟重启：全新日志与服务实例读同一目录。
  const log2 = new EventLog({ dir, clock: () => "2026-09-22T00:00:00.000Z" });
  const svc2 = new CustodyService(log2, { clock: () => "2026-09-22T00:00:00.000Z" });
  svc2.load();
  assert.equal(svc2.aliquots.get(tube.aliquot.id).state, "in_transit");

  const actions = svc2.tick();
  assert.ok(actions.some((a) => a.type === "handover_overdue" && a.handover_id === handover.handover_id));
  // tick 幂等：再跑一次不会重复补办。
  const again = svc2.tick();
  assert.equal(again.length, 0);

  const todos = svc2.getTodos();
  assert.ok(todos.some((todo) => todo.type === "handover_acceptance" && todo.overdue));

  // 重启后的服务仍可继续完成交接。
  svc2.acceptHandover(handover.handover_id, { receiver: "lab-a", temp: TEMP_OK, occurred_at: "2026-09-22T01:00:00.000Z" });
  assert.equal(svc2.aliquots.get(tube.aliquot.id).handovers[0].state, "accepted");
  dispose();
});

test("复测逾期产生复测待办并标记", () => {
  const harness = makeService({ start: "2026-09-20T00:00:00.000Z", retestDueMs: 86_400_000 });
  const { service, setTime, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);
  recordPositive(service, aliquotId, { qc: [{ type: "positive_control", passed: false }] });
  const conclusion = service.evaluate(sampleId, "OTTER_DNA");
  assert.equal(conclusion.decision, "needs_retest");
  assert.equal(service.getTodos("2026-09-20T00:00:00.000Z").some((t) => t.type === "retest"), true);

  setTime("2026-09-23T00:00:00.000Z");
  const actions = service.tick();
  assert.ok(actions.some((a) => a.type === "retest_overdue"));
  const current = service.conclusions.get(conclusion.id);
  assert.equal(current.overdue_marked, true);
  dispose();
});

test("追溯查询能从结论追回样本、保管断点、质控证据和批准人", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { sampleId, aliquotId } = setupSample(service);
  const recorded = recordPositive(service, aliquotId);
  const conclusion = service.evaluate(sampleId, "OTTER_DNA");
  const window = service.registerWindow({
    project_id: "P1",
    species_code: "OTTER_DNA",
    start_at: "2026-09-01",
    end_at: "2026-09-30",
    location: { lat: 30.1, lng: 120.2 },
  });
  service.confirmConclusion(conclusion.id, { reviewer: "pi-lee", window_id: window.id });

  const trace = service.trace(conclusion.id);
  assert.equal(trace.sample.id, sampleId);
  assert.equal(trace.sample.site.site_id, "SITE-7");
  assert.equal(trace.lineage.length, 1);
  assert.equal(trace.lineage[0].seal_id, "SEAL-1");
  const eventTypes = trace.lineage[0].events.map((e) => e.type);
  assert.deepEqual(eventTypes, ["ALIQUOT_PREPARED", "HANDOVER_OPENED", "HANDOVER_ACCEPTED", "TESTED"]);
  assert.equal(trace.results[0].result_id, recorded.result.id);
  assert.equal(trace.results[0].method.version, "1.4.2");
  assert.equal(trace.qc_evidence[0].control.type, "blank");
  assert.deepEqual(trace.approvals, [
    {
      conclusion_id: conclusion.id,
      version: 1,
      reviewer: "pi-lee",
      at: conclusion.confirmed_at,
      window_id: window.id,
    },
  ]);
  dispose();
});

test("事件日志被改动时重放抛出 ChainIntegrityError", () => {
  const harness = makeService();
  const { service, dir, dispose } = harness;
  setupSample(service);
  const file = join(dir, "chain.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.payload.location = "FRIDGE-FAKE"; // 试图改写历史内容
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, `${lines.join("\n")}\n`);

  const log2 = new EventLog({ dir });
  assert.throws(() => log2.load(), ChainIntegrityError);
  dispose();
});

test("删除日志中的一行导致链断裂被发现", () => {
  const harness = makeService();
  const { service, dir, dispose } = harness;
  setupSample(service);
  const file = join(dir, "chain.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  writeFileSync(file, `${lines[0]}\n${lines.slice(2).join("\n")}\n`);
  const log2 = new EventLog({ dir });
  assert.throws(() => log2.load(), ChainIntegrityError);
  dispose();
});

test("销毁后的管不能检测、在途管不能销毁", () => {
  const harness = makeService();
  const { service, dispose } = harness;
  const { aliquotId } = setupSample(service);
  service.destroyAliquot(aliquotId, { operator: "lab-a" });
  assert.throws(() => service.registerBatch({ lab: "lab-a", aliquot_ids: [aliquotId] }), /aliquot_destroyed|已销毁/);
  dispose();

  const h2 = makeService();
  const collected = h2.service.collectSample({ collector: "bob", site: { site_id: "X" }, temp: TEMP_OK });
  const tube = h2.service.prepareAliquot(collected.sample.id, { prepared_by: "bob", seal_id: "S2", destination_lab: "lab-a" });
  h2.service.openHandover(tube.aliquot.id, { shipped_by: "bob", seal_id: "S2" });
  assert.throws(() => h2.service.destroyAliquot(tube.aliquot.id, { operator: "bob" }), /在途/);
  h2.dispose();
});
