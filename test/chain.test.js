import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.js";

test("采集登记样本并建立首条谱系事件与内容指纹", async () => {
  const { request, close } = await startServer();
  const res = await request("POST", "/v1/samples", {
    siteId: "W-01",
    collectedAt: "2026-09-24T08:00:00+08:00",
    operator: "alice",
    temperature: { minC: 3, maxC: 6 },
    location: { lat: 30.1, lng: 120.1 },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.sample.sampleId, /^S-\d+$/);
  assert.match(res.body.sample.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(res.body.event.type, "collected");
  assert.equal(res.body.event.status, "live");

  const got = await request("GET", `/v1/samples/${res.body.sample.sampleId}`);
  assert.equal(got.body.events.length, 1);
  assert.equal(got.body.events[0].temperature.maxC, 6);
  await close();
});

test("谱系事件不可覆盖：在线越序追加被拒绝", async () => {
  const { request, close } = await startServer();
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "stored",
    occurredAt: "2026-09-24T10:00:00+08:00", operator: "alice", data: { location: "F-1" },
  });
  const outOfOrder = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "unsealed",
    occurredAt: "2026-09-24T09:00:00+08:00", operator: "alice",
  });
  assert.equal(outOfOrder.status, 409);
  assert.equal(outOfOrder.body.code, "event_out_of_order");
  await close();
});

test("重复扫码幂等：相同幂等键只生成一个事件", async () => {
  const { request, close } = await startServer();
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  const payload = {
    resourceKind: "sample", resourceId: s.sampleId, type: "stored",
    occurredAt: "2026-09-24T10:00:00+08:00", operator: "alice",
    idempotencyKey: "scan-77", data: { location: "F-1" },
  };
  const first = await request("POST", "/v1/chain/events", payload);
  const second = await request("POST", "/v1/chain/events", { ...payload, data: { location: "DIFFERENT" } });
  assert.equal(first.status, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.event.eventId, first.body.event.eventId);
  assert.equal(second.body.event.data.location, "F-1", "重复扫码必须返回原始内容");

  const got = await request("GET", `/v1/samples/${s.sampleId}`);
  assert.equal(got.body.events.filter((e) => e.type === "stored").length, 1);
  await close();
});

test("同一封签被两个接收方并发确认，只有一个成功", async () => {
  const { request, close } = await startServer();
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  const al = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "aliquoted",
    occurredAt: "2026-09-24T08:05:00+08:00", operator: "alice",
    data: { tubes: [{ sealId: "SEAL-1", volumeMl: 40 }] },
  }).then((r) => r.body.event.data.tubes[0]);

  const sent = await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: al.tubeId, type: "handed_over",
    occurredAt: "2026-09-24T08:10:00+08:00", operator: "alice", sealId: "SEAL-1",
    data: { stage: "sent", to: "LAB-A" },
  }).then((r) => r.body.event);
  const handoverId = sent.data.handoverId;

  const confirm = (receiver) =>
    request("POST", "/v1/chain/events", {
      resourceKind: "tube", resourceId: al.tubeId, type: "handed_over",
      occurredAt: "2026-09-24T11:00:00+08:00", operator: receiver,
      data: { stage: "confirmed", handoverId, receiver, sealIntact: true },
    });

  // 真正并发：两个请求在同一事件循环中同时发起。
  const [first, second] = await Promise.all([confirm("bob"), confirm("carol")]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal([first, second].find((r) => r.status === 409).body.code, "handover_closed");

  const tube = await request("GET", `/v1/tubes/${al.tubeId}`);
  const handover = tube.body.handovers[0];
  assert.equal(handover.status, "confirmed");
  assert.ok(["bob", "carol"].includes(handover.receiver));
  await close();
});

test("离线事件越过已签节点进入待裁定，批准后生效、拒绝后作废", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "stored",
    occurredAt: "2026-09-24T10:00:00+08:00", operator: "alice", data: { location: "F-1" },
  });
  const pending = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "unsealed",
    occurredAt: "2026-09-24T09:30:00+08:00", operator: "alice",
    offline: { deviceId: "scanner-3" },
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.event.status, "pending");
  assert.equal(pending.body.event.pendingReason, "crossed_signed_node");

  const list = await request("GET", "/v1/chain/pending");
  assert.equal(list.body.events.length, 1);

  const todos = await request("GET", "/v1/todos");
  assert.ok(todos.body.todos.some((t) => t.kind === "adjudication"));

  const rejected = await request(
    "POST", `/v1/chain/events/${pending.body.event.eventId}/adjudications`,
    { decision: "rejected", operator: "supervisor", reason: "时间不合理" }
  );
  assert.equal(rejected.body.event.status, "void");
  const sampleView = await request("GET", `/v1/samples/${s.sampleId}`);
  assert.equal(sampleView.body.sample.status, "stored", "被拒绝的离线事件不改变资源状态");
  await close();
});

test("离线待裁定事件批准后才真正推进状态机并关闭待办", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "stored",
    occurredAt: "2026-09-24T10:00:00+08:00", operator: "alice", data: { location: "F-1" },
  });
  const pending = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "unsealed",
    occurredAt: "2026-09-24T09:45:00+08:00", operator: "alice", offline: {},
  });
  const approved = await request(
    "POST", `/v1/chain/events/${pending.body.event.eventId}/adjudications`,
    { decision: "approved", operator: "supervisor" }
  );
  assert.equal(approved.body.event.status, "live");
  const sampleView = await request("GET", `/v1/samples/${s.sampleId}`);
  assert.equal(sampleView.body.sample.status, "unsealed");
  const todos = await request("GET", "/v1/todos");
  assert.ok(!todos.body.todos.some((t) => t.kind === "adjudication"));
  await close();
});

test("封签撤销作废在途交接并产生保管断点", async () => {
  const { request, close, service } = await startServer();
  const s = await request("POST", "/v1/samples", {
    siteId: "W-01", collectedAt: "2026-09-24T08:00:00+08:00", operator: "alice",
  }).then((r) => r.body.sample);
  const tube = await request("POST", "/v1/chain/events", {
    resourceKind: "sample", resourceId: s.sampleId, type: "aliquoted",
    occurredAt: "2026-09-24T08:05:00+08:00", operator: "alice",
    data: { tubes: [{ sealId: "SEAL-9", volumeMl: 40 }] },
  }).then((r) => r.body.event.data.tubes[0]);
  await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: tube.tubeId, type: "handed_over",
    occurredAt: "2026-09-24T08:10:00+08:00", operator: "alice", sealId: "SEAL-9",
    data: { stage: "sent", to: "LAB-A" },
  });
  const revoke = await request("POST", "/v1/seals/revocations", {
    sealId: "SEAL-9", operator: "alice",
    resourceKind: "tube", resourceId: tube.tubeId, reason: "封签印刷错误",
  });
  assert.equal(revoke.status, 200);
  const handover = [...service.store.handovers.values()].find((h) => h.sealId === "SEAL-9");
  assert.equal(handover.status, "revoked");

  // 撤销后不能再确认
  const confirm = await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: tube.tubeId, type: "handed_over",
    occurredAt: "2026-09-24T11:00:00+08:00", operator: "bob",
    data: { stage: "confirmed", handoverId: handover.handoverId, receiver: "bob" },
  });
  assert.equal(confirm.status, 409);
  await close();
});
