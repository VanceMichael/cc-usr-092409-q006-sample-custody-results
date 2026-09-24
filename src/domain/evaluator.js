import { CONCLUSION_CATEGORIES } from "./policy.js";

/**
 * 结论规则引擎。
 * 输入同一采样点、同一目标、同一观测窗口内的全部检测结果及其保管链，
 * 输出 consistent / conflict / suspected_contamination / needs_retest。
 *
 * 判定优先级：
 *   保管链完整性问题（冷链、封签、指纹）→ suspected_contamination
 *   分析可靠性问题（质控失败、方法过期、不确定度跨越阈值、仅单方结果）→ needs_retest
 *   结论相互矛盾 → conflict
 *   其余 → consistent
 */

const COLD_MIN_C = 2;
const COLD_MAX_C = 8;

export function isSensitive(target) {
  return target === "SPECIES_SENSITIVE" || target === "OTTER" || target === "STURGEON";
}

function tempExcursion(event) {
  const t = event?.temperature;
  if (!t) return null;
  if (typeof t.minC === "number" && t.minC < COLD_MIN_C) {
    return { eventId: event.eventId, type: "temperature_below_range", observed: t.minC };
  }
  if (typeof t.maxC === "number" && t.maxC > COLD_MAX_C) {
    return { eventId: event.eventId, type: "temperature_above_range", observed: t.maxC };
  }
  if (typeof t.excursionCount === "number" && t.excursionCount > 0) {
    return { eventId: event.eventId, type: "temperature_excursions_reported", count: t.excursionCount };
  }
  return null;
}

/** 沿样本管与原始样本的事件链，收集保管断点与温控问题。 */
export function inspectChain(result, store) {
  const tube = store.tubes.get(result.tubeId);
  const chainResourceIds = [];
  if (tube) chainResourceIds.push(["tube", tube.tubeId]);
  const sample = store.samples.get(result.sampleId);
  if (sample) chainResourceIds.push(["sample", sample.sampleId]);

  const breaks = [];
  const gaps = [];
  const events = [];

  for (const [kind, id] of chainResourceIds) {
    for (const eventId of store.resourceEvents.get(`${kind}:${id}`) ?? []) {
      const event = store.events.get(eventId);
      events.push(event);
      if (event.status === "pending") {
        gaps.push({ eventId, type: "event_pending_adjudication", at: event.occurredAt });
        continue;
      }
      if (event.status === "void") continue;
      const excursion = tempExcursion(event);
      if (excursion) breaks.push(excursion);

      if (event.type === "handed_over" && event.data.stage === "confirmed") {
        if (event.data.sealIntact === false) {
          breaks.push({ eventId, type: "seal_damaged_on_receipt", handoverId: event.data.handoverId });
        }
        if (event.data.fingerprintMismatch) {
          breaks.push({ eventId, type: "content_fingerprint_mismatch", handoverId: event.data.handoverId });
        }
      }
      if (event.type === "handed_over" && event.data.stage === "rejected") {
        gaps.push({ eventId, type: "handover_rejected", handoverId: event.data.handoverId });
      }
      if (event.type === "seal_revoked") {
        breaks.push({ eventId, type: "seal_revoked", sealId: event.sealId, at: event.occurredAt });
      }
    }
  }

  for (const handover of store.handovers.values()) {
    const matches =
      (tube && handover.resourceKind === "tube" && handover.resourceId === tube.tubeId) ||
      (sample && handover.resourceKind === "sample" && handover.resourceId === sample.sampleId);
    if (!matches) continue;
    if (handover.status === "revoked") {
      breaks.push({ type: "handover_on_revoked_seal", handoverId: handover.handoverId, sealId: handover.sealId });
    }
    if (handover.status === "pending") {
      gaps.push({ type: "handover_unconfirmed", handoverId: handover.handoverId });
    }
  }

  return { breaks, gaps, events };
}

function decideOutcome(result) {
  const cutoff = result.thresholds?.positiveAt;
  if (typeof cutoff !== "number") return { outcome: result.outcome ?? "positive", inconclusive: false };
  const u = typeof result.uncertainty?.value === "number" ? result.uncertainty.value : 0;
  const interval = [result.value - u, result.value + u];
  if (interval[0] <= cutoff && cutoff <= interval[1]) {
    return { outcome: result.value > cutoff ? "positive" : "negative", inconclusive: true };
  }
  return { outcome: result.value > cutoff ? "positive" : "negative", inconclusive: false };
}

/** 评估一个结果聚簇。 */
export function evaluateCluster(cluster, store) {
  const reasons = [];
  const chainBreaks = [];
  const chainGaps = [];
  const qcFailures = [];
  const evaluated = [];
  const labs = new Set();
  const methods = new Set();

  // 被复测取代的旧结果仍保留在谱系与溯源中，但不再作为有效证据参与判定。
  // 两种取代来源：显式 retestOfResultId；或同一分装管出现了更新的检测结果。
  const supersededResultIds = new Set();
  const byTube = new Map();
  for (const resultId of cluster.members) {
    const result = store.results.get(resultId);
    if (!result) continue;
    if (result.retestOfResultId) supersededResultIds.add(result.retestOfResultId);
    const list = byTube.get(result.tubeId) ?? [];
    list.push(result);
    byTube.set(result.tubeId, list);
  }
  for (const list of byTube.values()) {
    if (list.length < 2) continue;
    list
      .slice()
      .sort(
        (x, y) =>
          new Date(x.measuredAt) - new Date(y.measuredAt) ||
          new Date(x.recordedAt) - new Date(y.recordedAt)
      )
      .slice(0, -1)
      .forEach((r) => supersededResultIds.add(r.resultId));
  }

  for (const resultId of cluster.members) {
    const result = store.results.get(resultId);
    if (!result) continue;
    if (supersededResultIds.has(resultId)) continue;
    labs.add(result.labId);
    methods.add(`${result.methodId}@${result.methodVersion}`);
    const decision = decideOutcome(result);
    const chain = inspectChain(result, store);
    chainBreaks.push(...chain.breaks.map((b) => ({ ...b, resultId })));
    chainGaps.push(...chain.gaps.map((g) => ({ ...g, resultId })));

    const qc = result.qc ?? {};
    if (qc.blankPositive) qcFailures.push({ resultId, type: "blank_positive" });
    if (qc.controlPassed === false) qcFailures.push({ resultId, type: "control_out_of_range" });
    if (typeof qc.duplicateRpd === "number" && typeof qc.duplicateRpdLimit === "number" &&
        qc.duplicateRpd > qc.duplicateRpdLimit) {
      qcFailures.push({ resultId, type: "duplicate_rpd_exceeded", rpd: qc.duplicateRpd });
    }

    const method = store.methods.get(result.methodId);
    const methodOutdated = method && method.currentVersion !== result.methodVersion;
    if (methodOutdated) {
      qcFailures.push({
        resultId,
        type: "method_version_superseded",
        used: result.methodVersion,
        current: method.currentVersion,
      });
    }

    evaluated.push({
      resultId,
      labId: result.labId,
      batchId: result.batchId,
      value: result.value,
      unit: result.unit,
      outcome: decision.outcome,
      inconclusive: decision.inconclusive,
      methodOutdated,
    });
  }

  let category;
  if (chainBreaks.length > 0) {
    category = "suspected_contamination";
    reasons.push("保管链存在封签、冷链或内容指纹断点");
  } else if (qcFailures.length > 0) {
    category = "needs_retest";
    reasons.push("存在质控不合格或方法版本失效，需要复测");
  } else if (evaluated.some((r) => r.inconclusive)) {
    category = "needs_retest";
    reasons.push("结果不确定度区间跨越判定阈值");
  } else if (evaluated.length < 2 || labs.size < 2) {
    category = "needs_retest";
    reasons.push("仅有单家实验室结果，无法跨机构复核");
  } else {
    const positives = evaluated.filter((r) => r.outcome === "positive");
    const negatives = evaluated.filter((r) => r.outcome === "negative");
    if (positives.length > 0 && negatives.length > 0) {
      category = "conflict";
      reasons.push("不同实验室阴阳性结论冲突且未发现污染证据");
    } else {
      category = "consistent";
      reasons.push("多家实验室结论一致，质控与保管链完整");
    }
  }

  if (!CONCLUSION_CATEGORIES.includes(category)) throw new Error(`bad_category:${category}`);

  return {
    category,
    reasons,
    results: evaluated,
    distinctLabs: labs.size,
    methodSignatures: [...methods],
    chainBreaks,
    chainGaps,
    qcFailures,
  };
}
