/**
 * 归并规则与位置降精度策略（纯函数，便于单测）。
 */

/** 水样默认冷链要求（摄氏度），可在采集时按基质覆盖。 */
export const DEFAULT_TEMP_REQUIREMENT = { matrix: "water", min_c: 2, max_c: 8 };

export function evaluateTemperature(temp, requirement) {
  const excursions = [];
  if (!temp) return { acceptable: false, excursions: [{ reason: "missing_temp_summary" }] };
  if (typeof temp.min_c === "number" && temp.min_c < requirement.min_c) {
    excursions.push({ reason: "below_range", observed_c: temp.min_c, limit_c: requirement.min_c });
  }
  if (typeof temp.max_c === "number" && temp.max_c > requirement.max_c) {
    excursions.push({ reason: "above_range", observed_c: temp.max_c, limit_c: requirement.max_c });
  }
  for (const excursion of temp.excursions ?? []) {
    if (typeof excursion.max_c === "number" && excursion.max_c > requirement.max_c) {
    excursions.push({ reason: "logged_excursion", ...excursion });
    } else if (typeof excursion.min_c === "number" && excursion.min_c < requirement.min_c) {
      excursions.push({ reason: "logged_excursion", ...excursion });
    }
  }
  return { acceptable: excursions.length === 0, excursions };
}

/**
 * 评估一组实验室结果 + 保管断点，生成结论。
 * 结论代码：consistent | conflict | suspected_contamination | needs_retest
 *
 * @param {Array} results 已应用更正后的结果投影
 * @param {object} context { contamination, chainBreaks, adjudicationPending }
 *   contamination：封签破损、污染性质控失败等污染指征
 *   chainBreaks：冷链中断、超时交接、封签撤销、离线事件被驳回等链不可信情况
 */
export function evaluateConclusion(results, context = {}) {
  const reasons = [];
  const valid = results.filter((result) => !result.voided);
  // 每个依据结果的定性判读随结论留存；阈值/方法更正导致判读翻转时，
  // 即使决策大类相同也属于结论实质变化（需要替代版）。
  const calls = Object.fromEntries(valid.map((result) => [result.result_id, qualitativeCall(result)]));

  // 1) 污染迹象优先级最高：空白/阴性对照检出，或封签被确认破损。
  for (const result of valid) {
    for (const control of result.qc ?? []) {
      const contaminative = control.type === "blank" || control.type === "negative_control";
      if (contaminative && control.passed === false) {
        reasons.push({ code: "contaminative_qc_failure", result_id: result.result_id, type: control.type });
      }
    }
  }
  for (const item of context.contamination ?? []) {
    reasons.push({ code: item.type, event_id: item.event_id, aliquot_id: item.aliquot_id });
  }
  if (reasons.length > 0) {
    return { decision: "suspected_contamination", reasons, basis_result_ids: valid.map((r) => r.result_id), calls };
  }

  // 2) 链上存在待裁定的离线事件，不能直接给阳性/阴性一致结论。
  if ((context.adjudicationPending ?? []).length > 0) {
    reasons.push({ code: "chain_adjudication_pending", event_ids: context.adjudicationPending });
    return { decision: "needs_retest", reasons, basis_result_ids: valid.map((r) => r.result_id), calls };
  }

  // 3) 保管链不可信（冷链中断、超时、封签撤销、离线事件被驳回）→ 待复测。
  for (const item of context.chainBreaks ?? []) {
    reasons.push({ code: item.type, event_id: item.event_id, aliquot_id: item.aliquot_id });
  }

  // 3) 非污染性质控失败、或结果落在阈值不确定度带内 → 待复测。
  for (const result of valid) {
    for (const control of result.qc ?? []) {
      if (control.passed === false) {
        reasons.push({ code: "qc_failure", result_id: result.result_id, type: control.type });
      }
    }
    if (isEquivocal(result)) {
      reasons.push({ code: "within_uncertainty_band", result_id: result.result_id });
    }
  }
  if (reasons.length > 0) {
    return { decision: "needs_retest", reasons, basis_result_ids: valid.map((r) => r.result_id), calls };
  }

  if (valid.length === 0) {
    return { decision: "needs_retest", reasons: [{ code: "no_valid_result" }], basis_result_ids: [], calls: {} };
  }

  // 4) 多家实验室结果互不兼容 → 冲突。
  const conflict = findConflict(valid);
  if (conflict) {
    reasons.push(conflict);
    return { decision: "conflict", reasons, basis_result_ids: valid.map((r) => r.result_id), calls };
  }

  // 5) 结果一致（定性同向，或数值差在合成不确定度内）。
  return {
    decision: "consistent",
    reasons: [{ code: "results_agree", count: valid.length }],
    basis_result_ids: valid.map((r) => r.result_id), calls,
  };
}

function isEquivocal(result) {
  if (typeof result.value !== "number" || !result.threshold || typeof result.threshold.cutoff !== "number") {
    return false;
  }
  const band = expandedUncertainty(result);
  return Math.abs(result.value - result.threshold.cutoff) <= band;
}

function expandedUncertainty(result) {
  const u = result.uncertainty?.value;
  if (typeof u !== "number") return 0;
  const k = result.uncertainty?.k ?? 2;
  return u * k;
}

/** 依据阈值给出定性判读。 */
export function qualitativeCall(result) {
  if (typeof result.qualitative === "string") return result.qualitative;
  return computeCall(result);
}

/** 忽略已固化的 qualitative，严格按当前数值与阈值重新判读（更正后重算用）。 */
export function computeCall(result) {
  if (typeof result.value !== "number" || !result.threshold || typeof result.threshold.cutoff !== "number") {
    return null;
  }
  const { cutoff, comparator = "gte" } = result.threshold;
  if (comparator === "gte") return result.value >= cutoff ? "positive" : "negative";
  return result.value <= cutoff ? "positive" : "negative";
}

function findConflict(results) {
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const a = results[i];
      const b = results[j];
      const callA = qualitativeCall(a);
      const callB = qualitativeCall(b);
      if (callA && callB && callA !== callB) {
        return { code: "qualitative_disagreement", result_ids: [a.result_id, b.result_id], calls: [callA, callB] };
      }
      if (typeof a.value === "number" && typeof b.value === "number" && a.unit === b.unit) {
        const gap = Math.abs(a.value - b.value);
        const tolerance = expandedUncertainty(a) + expandedUncertainty(b);
        if (gap > tolerance) {
          return { code: "values_diverge_beyond_uncertainty", result_ids: [a.result_id, b.result_id], gap, tolerance };
        }
      }
    }
  }
  return null;
}

/**
 * 敏感物种位置降精度。
 * tier: exact（原样） | grid（网格，默认 0.05°） | region（区域，默认 0.5°） | withhold（隐去）
 */
export function reducePrecision(location, tier, options = {}) {
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
    return { precision: tier, location: null };
  }
  if (tier === "exact") {
    return { precision: "exact", location: { lat: location.lat, lng: location.lng } };
  }
  if (tier === "withhold") {
    return { precision: "withhold", location: null };
  }
  const size = tier === "grid" ? options.grid_size ?? 0.05 : options.region_size ?? 0.5;
  const minLat = Math.floor(location.lat / size) * size;
  const minLng = Math.floor(location.lng / size) * size;
  const center = { lat: round(minLat + size / 2), lng: round(minLng + size / 2) };
  const cell = `${tier === "grid" ? "GRID" : "REG"}:${round(minLat)}:${round(minLng)}`;
  return { precision: tier, location: center, cell, cell_size: size };
}

function round(value) {
  return Number(value.toFixed(6));
}

/** 查询项目内某角色对敏感物种的位置精度等级。 */
export function precisionForActor(policy, actor) {
  if (!policy) return "withhold";
  const membership = policy.members?.find((member) => member.actor === actor);
  const role = membership?.role;
  if (!role) return policy.default_precision ?? "withhold";
  return policy.precision_by_role?.[role] ?? policy.default_precision ?? "withhold";
}

export function isSensitiveSpecies(policy, speciesCode) {
  return Boolean(policy?.sensitive_species?.includes(speciesCode));
}
