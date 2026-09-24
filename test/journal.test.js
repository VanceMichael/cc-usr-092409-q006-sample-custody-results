import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/domain/journal.js";
import { startServer, setupTwoLabScenario } from "./helpers.js";

test("日志为哈希链：篡改任意一行在重放校验时被发现", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wom-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "chain.journal.jsonl");
  const journal = new Journal(file);
  journal.append("sample_registered", { sample: { sampleId: "S-1" } });
  journal.append("batch_registered", { batch: { batchId: "B-1" } });

  // 重放完好文件通过
  assert.equal(new Journal(file).verify(), 2);

  // 篡改第二行载荷（hash 未同步）→ 校验失败
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.payload.batch.batchId = "B-999";
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, `${lines.join("\n")}\n`);
  assert.throws(() => new Journal(file).verify(), /tampered/);

  // 断链：追加一条 prevHash 不指向链头的记录
  writeFileSync(file, `${lines[0]}\n`);
  appendFileSync(file, `${JSON.stringify({ ...JSON.parse(lines[0]), seq: 2, prevHash: "x".repeat(64) })}\n`);
  assert.throws(() => new Journal(file).verify(), /journal_broken|journal_tampered/);
});

test("销毁事件后不能再检测；离线补录则进入待裁定", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request);
  // 直接销毁 A 管
  const destroyed = await request("POST", "/v1/chain/events", {
    resourceKind: "tube", resourceId: scene.ids.tubeA.tubeId, type: "destroyed",
    occurredAt: scene.ISO(14), operator: "bob", sealId: "SEAL-A",
    data: { reason: "检测后按规程销毁" },
  });
  assert.equal(destroyed.status, 201);

  const later = await request("POST", "/v1/results", {
    labId: "LAB-A", batchId: scene.ids.batchA, tubeId: scene.ids.tubeA.tubeId,
    sampleId: scene.ids.sampleId, target: "SPECIES_X",
    methodId: scene.ids.methodId, methodVersion: "1.0",
    value: 99, measuredAt: scene.ISO(15), operator: "ta",
  });
  assert.equal(later.status, 409);
  assert.equal(later.body.code, "tube_destroyed");
});

test("接收时上报内容指纹不一致判为疑似污染", async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const scene = await setupTwoLabScenario(request, {
    confirmB: { sealIntact: true, fingerprintMismatch: true },
  });
  const a = await scene.resultA(15);
  await scene.resultB(14);
  const concl = (await request("GET", `/v1/conclusions/${a.clusterKey}`)).body.conclusion;
  assert.equal(concl.versions.at(-1).category, "suspected_contamination");
  assert.ok(concl.versions.at(-1).chainBreaks.some((b) => b.type === "content_fingerprint_mismatch"));
});
