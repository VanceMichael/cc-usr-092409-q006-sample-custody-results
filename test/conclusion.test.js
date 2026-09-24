import assert from "node:assert/strict";
import test from "node:test";
import { startServer, setupTwoLabScenario } from "./helpers.js";

async function draftOf(request, clusterKey, role) {
  const res = await request("GET", `/v1/conclusions/${clusterKey}`, undefined, role ? { "x-project-role": role } : {});
  return res.body.conclusion;
}

test("两家实验室一致阳性：生成 consistent，确认后才关联观测窗口", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15);
  const key = a.clusterKey;

  // 仅单方结果时是 needs_retest
  assert.equal(a.conclusion.versions.at(-1).category, "needs_retest");

  // 第二家结果到达后转为 consistent
  await scene.resultB(14);
  const concl = await draftOf(request, key);
  assert.equal(concl.versions.at(-1).category, "consistent");

  // 未确认前列表中没有观测
  assert.equal((await request("GET", "/v1/observations")).body.observations.length, 0);

  const confirmed = await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.observation.category, "consistent");
  assert.ok(confirmed.body.observation.observationId);
  assert.equal(confirmed.body.observation.confirmedBy, "dr-li");

  const obs = (await request("GET", "/v1/observations")).body.observations;
  assert.equal(obs.length, 1);
  assert.equal(obs[0].target, "SPECIES_X");
});

test("两家实验室阴阳性冲突：生成 conflict", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15); // 阳性
  await scene.resultB(3); // 阴性
  const concl = await draftOf(request, a.clusterKey);
  assert.equal(concl.versions.at(-1).category, "conflict");
  assert.ok(concl.versions.at(-1).reasons.join(";").includes("冲突"));
});

test("冷链越界优先判为 suspected_contamination，即便结果一阴一阳", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, {
    tempB: { maxC: 12 }, // B 管交接途中超过 8℃
  });
  const a = await scene.resultA(15);
  await scene.resultB(3);
  const concl = await draftOf(request, a.clusterKey);
  assert.equal(concl.versions.at(-1).category, "suspected_contamination");
  const breaks = concl.versions.at(-1).chainBreaks;
  assert.ok(breaks.some((b) => b.type === "temperature_above_range"));
});

test("接收时封签破损判为疑似污染", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, {
    confirmB: { sealIntact: false },
  });
  const a = await scene.resultA(15);
  await scene.resultB(14);
  const concl = await draftOf(request, a.clusterKey);
  assert.equal(concl.versions.at(-1).category, "suspected_contamination");
  assert.ok(concl.versions.at(-1).chainBreaks.some((b) => b.type === "seal_damaged_on_receipt"));
});

test("质控失败生成 needs_retest", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15, { qc: { controlPassed: false } });
  await scene.resultB(14, { qc: { controlPassed: true } });
  const concl = await draftOf(request, a.clusterKey);
  assert.equal(concl.versions.at(-1).category, "needs_retest");
  assert.ok(concl.versions.at(-1).qcFailures.some((f) => f.type === "control_out_of_range"));
  const todos = (await request("GET", "/v1/todos")).body.todos;
  assert.ok(todos.some((todo) => todo.kind === "retest_due"));
});

test("不确定度区间跨越阈值时生成 needs_retest", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(10.5, { uncertainty: { value: 1, unit: "x" } });
  await scene.resultB(14, { uncertainty: { value: 1, unit: "x" } });
  const concl = await draftOf(request, a.clusterKey);
  assert.equal(concl.versions.at(-1).category, "needs_retest");
  assert.ok(concl.versions.at(-1).reasons.join(";").includes("不确定度"));
});

test("结果保留方法版本、阈值、质控样与不确定度，可从结果接口取回", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  const a = await scene.resultA(15, {
    unit: "copies/ml",
    thresholds: { positiveAt: 10 },
    uncertainty: { value: 0.4, unit: "copies/ml" },
    qc: { controlPassed: true, blankPositive: false, duplicateRpd: 3, duplicateRpdLimit: 15 },
  });
  const got = await request("GET", `/v1/results/${a.result.resultId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.result.methodVersion, "1.0");
  assert.equal(got.body.result.thresholds.positiveAt, 10);
  assert.equal(got.body.result.uncertainty.value, 0.4);
  assert.equal(got.body.result.qc.duplicateRpd, 3);
});

test("敏感物种位置按项目角色降精度，公开角色不给坐标", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, { target: "OTTER" });
  const a = await scene.resultA(15);
  await scene.resultB(14);
  const key = a.clusterKey;
  await request("POST", `/v1/conclusions/${key}/confirmations`, { operator: "dr-li" });

  const lead = (await request("GET", "/v1/observations", undefined, { "x-project-role": "project_lead" })).body.observations[0];
  const researcher = (await request("GET", "/v1/observations", undefined, { "x-project-role": "researcher" })).body.observations[0];
  const volunteer = (await request("GET", "/v1/observations", undefined, { "x-project-role": "volunteer" })).body.observations[0];
  const pub = (await request("GET", "/v1/observations", undefined, { "x-project-role": "public" })).body.observations[0];

  assert.deepEqual(lead.location, { lat: 30.123456, lng: 120.123456, precision: "exact" });
  assert.equal(researcher.location.precision, "~1km");
  assert.equal(researcher.location.lat, 30.12);
  assert.equal(volunteer.location.lat, 30.1);
  assert.equal(pub.location.precision, "withheld");
});

test("非敏感目标对任何角色都返回精确位置", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, { target: "EGRET" });
  const a = await scene.resultA(15);
  await scene.resultB(14);
  await request("POST", `/v1/conclusions/${a.clusterKey}/confirmations`, { operator: "dr-li" });
  const pub = (await request("GET", "/v1/observations", undefined, { "x-project-role": "public" })).body.observations[0];
  assert.equal(pub.location.precision, "exact");
});
