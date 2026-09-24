import { randomUUID } from "node:crypto";
import { DomainError, assert } from "./errors.js";
import { computeCall, evaluateConclusion, evaluateTemperature, isSensitiveSpecies, precisionForActor, qualitativeCall, reducePrecision } from "./policy.js";

const HANDOVER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RETEST_DUE_MS = 72 * 60 * 60 * 1000;

const RESULT_FIELDS = ["method", "threshold", "uncertainty", "qc", "value", "unit", "qualitative", "analyzed_at"];

function newId(prefix) {
  return `${prefix}${randomUUID().slice(0, 12)}`;
}

/**
 * 保管链与结果归并核心服务。
 * 所有写操作都同步追加到仅追加事件日志；状态由事件重放得到，永不就地覆盖。
 */
export class CustodyService {
  constructor(eventLog, options = {}) {
    this.log = eventLog;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.handoverTimeoutMs = options.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS;
    this.retestDueMs = options.retestDueMs ?? RETEST_DUE_MS;
    this.samples = new Map();
    this.aliquots = new Map();
    this.batches = new Map();
    this.results = new Map();
    this.conclusions = new Map();
    this.windows = new Map();
    this.projects = new Map();
    /** sample_id|analyte -> 当前版本结论实体 ID */
    this.conclusionIndex = new Map();
    this.handoverIndex = new Map();
  }

  load() {
    this.log.load();
    for (const envelope of this.log.events) this.#reduce(envelope);
    return this;
  }

  // ------------------------------------------------------------- 投影重放

  #reduce(e) {
    const p = e.payload;
    switch (e.type) {
      case "PROJECT_POLICY_UPDATED":
        this.projects.set(e.entity_id, { id: e.entity_id, ...p.policy });
        break;

      case "SAMPLE_COLLECTED":
        this.samples.set(e.entity_id, {
          id: e.entity_id,
          project_id: p.project_id,
          site: p.site,
          matrix: p.matrix,
          temp_requirement: p.temp_requirement,
          collected_at: e.occurred_at,
          collector: e.operator,
          state: "collected",
          events: [e],
        });
        break;
      case "SAMPLE_DESTROYED": {
        const sample = this.samples.get(e.entity_id);
        sample.state = "destroyed";
        sample.events.push(e);
        break;
      }

      case "ALIQUOT_PREPARED": {
        const aliquot = {
          id: e.entity_id,
          sample_id: p.sample_id,
          tube_barcode: p.tube_barcode,
          seal_id: p.seal_id,
          destination_lab: p.destination_lab,
          volume_ml: p.volume_ml,
          state: "prepared",
          holder: e.operator,
          handovers: [],
          resolved_event_ids: new Set(),
          events: [e],
        };
        this.aliquots.set(e.entity_id, aliquot);
        break;
      }
      case "HANDOVER_OPENED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.state = "in_transit";
        aliquot.holder = e.operator;
        const handover = {
          id: p.handover_id,
          seal_id: p.seal_id,
          expected_receiver: p.expected_receiver,
          due_at: p.due_at,
          shipped_at: e.occurred_at,
          state: "pending",
          overdue: false,
        };
        aliquot.handovers.push(handover);
        this.handoverIndex.set(p.handover_id, aliquot.id);
        aliquot.events.push(e);
        break;
      }
      case "HANDOVER_OVERDUE": {
        const aliquot = this.aliquots.get(e.entity_id);
        const handover = aliquot.handovers.find((h) => h.id === p.handover_id);
        if (handover && handover.state === "pending") handover.overdue = true;
        aliquot.events.push(e);
        break;
      }
      case "HANDOVER_ACCEPTED": {
        const aliquot = this.aliquots.get(e.entity_id);
        const handover = aliquot.handovers.find((h) => h.id === p.handover_id);
        if (handover) {
          handover.state = "accepted";
          handover.accepted_at = e.occurred_at;
          handover.receiver = e.operator;
          handover.seal_intact = p.seal_intact;
          handover.overdue = false;
        }
        aliquot.state = "received";
        aliquot.holder = e.operator;
        aliquot.events.push(e);
        break;
      }
      case "STORED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.state = "stored";
        aliquot.storage = { location: p.location, since: e.occurred_at };
        aliquot.events.push(e);
        break;
      }
      case "OPENED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.state = "opened";
        aliquot.opened_at = e.occurred_at;
        aliquot.events.push(e);
        break;
      }
      case "SEAL_REVOKED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.seal_revoked = { seal_id: p.seal_id, reason: p.reason, at: e.occurred_at };
        aliquot.events.push(e);
        break;
      }
      case "TESTED": {
        this.aliquots.get(e.entity_id)?.events.push(e);
        break;
      }
      case "ALIQUOT_DESTROYED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.state = "destroyed";
        aliquot.destroyed_at = e.occurred_at;
        aliquot.events.push(e);
        break;
      }
      case "ADJUDICATION_RESOLVED": {
        const aliquot = this.aliquots.get(e.entity_id);
        aliquot.resolved_event_ids.add(p.event_id);
        aliquot.events.push(e);
        break;
      }

      case "BATCH_REGISTERED":
        this.batches.set(e.entity_id, {
          id: e.entity_id,
          lab: p.lab,
          aliquot_ids: p.aliquot_ids,
          method_id: p.method_id ?? null,
          created_at: e.occurred_at,
          events: [e],
        });
        break;

      case "RESULT_RECORDED": {
        this.results.set(e.entity_id, {
          id: e.entity_id,
          batch_id: p.batch_id,
          aliquot_id: p.aliquot_id,
          sample_id: p.sample_id,
          lab: p.lab,
          analyte: p.analyte,
          method: p.method,
          threshold: p.threshold,
          value: p.value,
          unit: p.unit,
          qualitative: p.qualitative,
          uncertainty: p.uncertainty,
          qc: p.qc ?? [],
          analyzed_at: e.occurred_at,
          retest_of: p.retest_of ?? null,
          late: p.late ?? false,
          voided: false,
          retest_superseded: false,
          corrections: [],
          events: [e],
        });
        // 复测结果到达后，被复测的原结果不再参与结论判定（仍保留在谱系与追溯中）。
        if (p.retest_of && this.results.has(p.retest_of)) {
          this.results.get(p.retest_of).retest_superseded = true;
        }
        break;
      }
      case "RESULT_CORRECTED": {
        const result = this.results.get(e.entity_id);
        result.corrections.push({ at: e.recorded_at, by: e.operator, reason: p.reason, changes: p.changes });
        for (const field of RESULT_FIELDS) {
          if (p.changes[field] !== undefined) result[field] = p.changes[field];
        }
        // 阈值/数值更正后，固化的定性判读必须按更正后的依据重算，
        // 否则阳性/阴性翻转无法反映到结论重评中；显式更正 qualitative 时除外。
        if (p.changes.qualitative === undefined) {
          const recomputed = computeCall(result);
          if (recomputed !== null) result.qualitative = recomputed;
        }
        result.events.push(e);
        break;
      }

      case "CONCLUSION_PROPOSED":
        this.conclusions.set(e.entity_id, {
          id: e.entity_id,
          sample_id: p.sample_id,
          analyte: p.analyte,
          version: p.version,
          supersedes: p.supersedes ?? null,
          status: "proposed",
          decision: p.evaluation.decision,
          evaluation: p.evaluation,
          retest_due_at: p.retest_due_at ?? null,
          overdue_marked: false,
          events: [e],
        });
        this.conclusionIndex.set(`${p.sample_id}|${p.analyte}`, e.entity_id);
        break;
      case "CONCLUSION_REEVALUATED": {
        const conclusion = this.conclusions.get(e.entity_id);
        conclusion.version = p.version;
        conclusion.decision = p.evaluation.decision;
        conclusion.evaluation = p.evaluation;
        conclusion.retest_due_at = p.retest_due_at ?? null;
        conclusion.overdue_marked = false;
        conclusion.events.push(e);
        break;
      }
      case "CONCLUSION_RETEST_OVERDUE": {
        const conclusion = this.conclusions.get(e.entity_id);
        conclusion.overdue_marked = true;
        conclusion.events.push(e);
        break;
      }
      case "CONCLUSION_CONFIRMED": {
        const conclusion = this.conclusions.get(e.entity_id);
        conclusion.status = "confirmed";
        conclusion.reviewer = e.operator;
        conclusion.confirmed_at = e.occurred_at;
        conclusion.window_id = p.window_id;
        conclusion.events.push(e);
        if (p.window_id && this.windows.has(p.window_id)) {
          this.windows.get(p.window_id).linked.push({
            conclusion_id: conclusion.id,
            sample_id: conclusion.sample_id,
            analyte: conclusion.analyte,
            decision: conclusion.decision,
            reviewer: e.operator,
          });
        }
        break;
      }
      case "CONCLUSION_SUPERSEDED": {
        const conclusion = this.conclusions.get(e.entity_id);
        conclusion.status = "superseded";
        conclusion.superseded_by = p.new_id;
        conclusion.events.push(e);
        break;
      }

      case "WINDOW_REGISTERED":
        this.windows.set(e.entity_id, {
          id: e.entity_id,
          project_id: p.project_id,
          species_code: p.species_code,
          grid: p.grid ?? null,
          start_at: p.start_at,
          end_at: p.end_at,
          location: p.location ?? null,
          linked: [],
          events: [e],
        });
        break;

      default:
        // 未知事件类型仍保留在日志中，投影忽略但不报错（前向兼容）。
        break;
    }
  }

  #append(entityType, entityId, type, payload, { requestId, scanNonce, occurredAt, operator, temp, offline = false } = {}) {
    assert(operator, "operator_required", "事件必须记录操作者", { status: 400 });
    const occurredAtIso = occurredAt ?? this.clock();
    const { _semantic_key, ...rest } = payload;

    // 离线补报事件：发生时间早于该实体链上最后一个已签（在线确认）节点即越序，
    // 统一进入待裁定，不直接并入链上结论。
    let outOfOrder = false;
    if (offline) {
      const history = this.log.history(entityId);
      const signed = history.filter((event) => !event.offline || event.payload?.requires_adjudication === false);
      const head = signed[signed.length - 1];
      outOfOrder = Boolean(head && new Date(occurredAtIso).getTime() < new Date(head.occurred_at).getTime());
    }

    // scan_nonce 是扫码事务号，全局标识一次物理扫码动作：
    // 即使实体 ID 由服务端生成、请求号被更换，重复扫码仍只生效一次。
    const dedupKey = scanNonce ? `scan:${scanNonce}` : `${type}:${entityId}|${payload._semantic_key ?? ""}`;

    return this.log.append({
      request_id: requestId,
      entity_type: entityType,
      entity_id: entityId,
      type,
      occurred_at: occurredAtIso,
      recorded_at: this.clock(),
      operator,
      temp: temp ?? null,
      offline,
      payload: {
        ...rest,
        out_of_order: outOfOrder,
        requires_adjudication: outOfOrder,
        _dedup_key: dedupKey,
      },
    });
  }

  /** 追加事件后立即投影，保证同一进程内读己之写。 */
  #commit(result) {
    if (!result.duplicated) this.#reduce(result.envelope);
    return result;
  }

  // ------------------------------------------------------------- 项目策略

  upsertProject(projectId, policy) {
    assert(projectId, "project_id_required", "缺少项目 ID", { status: 400 });
    const { envelope } = this.log.append({
      entity_type: "project",
      entity_id: projectId,
      type: "PROJECT_POLICY_UPDATED",
      occurred_at: this.clock(),
      recorded_at: this.clock(),
      operator: policy.updated_by ?? "system",
      payload: {
        policy: {
          sensitive_species: policy.sensitive_species ?? [],
          members: policy.members ?? [],
          precision_by_role: policy.precision_by_role ?? {},
          default_precision: policy.default_precision ?? "withhold",
        },
        _dedup_key: null,
      },
    });
    this.#reduce(envelope);
    return envelope;
  }

  // ------------------------------------------------------------- 现场样本

  collectSample(input) {
    const sampleId = input.sample_id ?? newId("S");
    assert(input.site?.site_id, "site_required", "采集事件必须记录采样点", { status: 400 });
    const requirement = input.temp_requirement ?? { matrix: input.matrix ?? "water", min_c: 2, max_c: 8 };
    const tempCheck = evaluateTemperature(input.temp, requirement);
    const result = this.#append(
      "sample",
      sampleId,
      "SAMPLE_COLLECTED",
      {
        project_id: input.project_id ?? null,
        site: input.site,
        matrix: input.matrix ?? "water",
        temp_requirement: requirement,
        cold_chain: { acceptable: tempCheck.acceptable, excursions: tempCheck.excursions },
        _semantic_key: "collect",
      },
      {
        requestId: input.request_id,
        scanNonce: input.scan_nonce,
        occurredAt: input.collected_at,
        operator: input.collector,
        temp: input.temp ?? null,
        offline: input.offline ?? false,
      },
    );
    this.#commit(result);
    return { sample: this.samples.get(result.envelope.entity_id), duplicated: result.duplicated, event: result.envelope };
  }

  destroySample(sampleId, input) {
    const sample = this.#requireSample(sampleId);
    assert(sample.state !== "destroyed", "sample_destroyed", "样本已销毁");
    const result = this.#append(
      "sample",
      sampleId,
      "SAMPLE_DESTROYED",
      { method: input.method ?? "incineration", reason: input.reason ?? null, _semantic_key: `destroy:${input.occurred_at ?? this.clock()}` },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.operator, temp: input.temp ?? null },
    );
    this.#commit(result);
    return { duplicated: result.duplicated, event: result.envelope };
  }

  // ------------------------------------------------------------- 分装管

  prepareAliquot(sampleId, input) {
    const sample = this.#requireSample(sampleId);
    assert(sample.state !== "destroyed", "sample_destroyed", "样本已销毁，不能分装");
    assert(input.seal_id, "seal_required", "分装管必须加施一次性封签", { status: 400 });
    const aliquotId = input.aliquot_id ?? newId("A");
    const result = this.#append(
      "aliquot",
      aliquotId,
      "ALIQUOT_PREPARED",
      {
        sample_id: sampleId,
        tube_barcode: input.tube_barcode ?? aliquotId,
        seal_id: input.seal_id,
        destination_lab: input.destination_lab ?? null,
        volume_ml: input.volume_ml ?? null,
        _semantic_key: `prepare:${input.tube_barcode ?? aliquotId}`,
      },
      { requestId: input.request_id, scanNonce: input.scan_nonce, occurredAt: input.occurred_at, operator: input.prepared_by, temp: input.temp ?? null },
    );
    this.#commit(result);
    return { aliquot: this.aliquots.get(result.envelope.entity_id), duplicated: result.duplicated, event: result.envelope };
  }

  openHandover(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    assert(["prepared", "received", "stored"].includes(aliquot.state), "invalid_state", `当前状态 ${aliquot.state} 不能发起交接`);
    assert(input.seal_id === aliquot.seal_id, "seal_mismatch", "封签编号与分装管不一致", { status: 409 });
    assert(!aliquot.seal_revoked, "seal_revoked", "封签已被撤销，不能交接", { status: 409 });
    const handoverId = input.handover_id ?? newId("H");
    const occurredAt = input.occurred_at ?? this.clock();
    const dueAt = input.due_at ?? new Date(new Date(occurredAt).getTime() + this.handoverTimeoutMs).toISOString();
    const result = this.#append(
      "aliquot",
      aliquotId,
      "HANDOVER_OPENED",
      {
        handover_id: handoverId,
        seal_id: input.seal_id,
        expected_receiver: input.expected_receiver ?? aliquot.destination_lab,
        due_at: dueAt,
        _semantic_key: `handover-open:${handoverId}`,
      },
      { requestId: input.request_id, scanNonce: input.scan_nonce, occurredAt, operator: input.shipped_by, temp: input.temp ?? null },
    );
    this.#commit(result);
    return { handover_id: handoverId, duplicated: result.duplicated, event: result.envelope };
  }

  /**
   * 接收方扫码确认封签。重复扫码幂等；两个接收方并发确认时只有一个成功
   * （同步追加 + 状态检查使先到者落盘，后到者收到 409）。
   */
  acceptHandover(handoverId, input) {
    const aliquotId = this.handoverIndex.get(handoverId);
    assert(aliquotId, "handover_not_found", "交接单不存在", { status: 404 });
    const aliquot = this.#requireAliquot(aliquotId);
    const handover = aliquot.handovers.find((h) => h.id === handoverId);

    // 已确认时的同请求/同扫码重试：接收方也一致才幂等返回原事件。
    if (handover.state === "accepted") {
      const acceptEvent = aliquot.events.find(
        (event) => event.type === "HANDOVER_ACCEPTED" && event.payload.handover_id === handoverId,
      );
      const sameRequest = Boolean(input.request_id && acceptEvent?.request_id === input.request_id);
      const sameScan = Boolean(input.scan_nonce && acceptEvent?.payload._dedup_key === `scan:${input.scan_nonce}`);
      if ((sameRequest || sameScan) && handover.receiver === input.receiver) {
        return { duplicated: true, event: acceptEvent, handover_id: handoverId, breaks: acceptEvent.payload.breaks ?? [], requires_adjudication: acceptEvent.payload.requires_adjudication ?? false };
      }
    }

    // 非指定接收方无论封签状态如何一律拒绝。
    if (handover.expected_receiver && input.receiver !== handover.expected_receiver) {
      throw new DomainError("wrong_receiver", `该封签指定接收方为 ${handover.expected_receiver}`, { status: 409 });
    }

    // 指定接收方重复确认（新请求号）→ 封签已确认冲突。
    if (handover.state === "accepted") {
      throw new DomainError("seal_already_confirmed", `封签 ${handover.seal_id} 已被 ${handover.receiver} 确认，不能重复确认`, { status: 409 });
    }

    const sample = this.#requireSample(aliquot.sample_id);
    const tempCheck = evaluateTemperature(input.temp, sample.temp_requirement);
    const late = handover.due_at && (input.occurred_at ?? this.clock()) > handover.due_at;

    const breaks = [];
    if (input.seal_intact === false) breaks.push({ type: "seal_compromised", detail: "接收时封签破损" });
    if (!tempCheck.acceptable) breaks.push({ type: "temperature_excursion", detail: tempCheck.excursions });
    if (late) breaks.push({ type: "late_handover", due_at: handover.due_at });

    const result = this.#append(
      "aliquot",
      aliquotId,
      "HANDOVER_ACCEPTED",
      {
        handover_id: handoverId,
        seal_id: handover.seal_id,
        seal_intact: input.seal_intact !== false,
        cold_chain: { acceptable: tempCheck.acceptable, excursions: tempCheck.excursions },
        breaks,
        _semantic_key: `accept:${handoverId}`,
      },
      {
        requestId: input.request_id,
        scanNonce: input.scan_nonce,
        occurredAt: input.occurred_at,
        operator: input.receiver,
        temp: input.temp ?? null,
        offline: input.offline ?? false,
      },
    );
    this.#commit(result);

    if (!result.duplicated) {
      for (const analyte of this.#analytesForSample(aliquot.sample_id)) {
        this.#reevaluate(aliquot.sample_id, analyte, { trigger: "handover_accepted" });
      }
    }
    return {
      duplicated: result.duplicated,
      event: result.envelope,
      handover_id: handoverId,
      breaks: result.duplicated ? result.envelope.payload.breaks : breaks,
      requires_adjudication: result.envelope.payload.requires_adjudication,
    };
  }

  store(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    assert(["received", "stored"].includes(aliquot.state), "invalid_state", `状态 ${aliquot.state} 不能入库`);
    const sample = this.#requireSample(aliquot.sample_id);
    const tempCheck = evaluateTemperature(input.temp, sample.temp_requirement);
    const result = this.#append(
      "aliquot",
      aliquotId,
      "STORED",
      {
        location: input.location,
        cold_chain: { acceptable: tempCheck.acceptable, excursions: tempCheck.excursions },
        breaks: tempCheck.acceptable ? [] : [{ type: "temperature_excursion", detail: tempCheck.excursions }],
        _semantic_key: `store:${input.location}:${input.occurred_at ?? this.clock()}`,
      },
      { requestId: input.request_id, scanNonce: input.scan_nonce, occurredAt: input.occurred_at, operator: input.operator, temp: input.temp ?? null, offline: input.offline ?? false },
    );
    this.#commit(result);
    if (!result.duplicated && (!tempCheck.acceptable || result.envelope.payload.requires_adjudication)) {
      for (const analyte of this.#analytesForSample(aliquot.sample_id)) {
        this.#reevaluate(aliquot.sample_id, analyte, { trigger: "storage_recorded" });
      }
    }
    return { duplicated: result.duplicated, event: result.envelope };
  }

  open(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    assert(["stored", "received"].includes(aliquot.state), "invalid_state", `状态 ${aliquot.state} 不能开封`);
    const result = this.#append(
      "aliquot",
      aliquotId,
      "OPENED",
      { seal_id: aliquot.seal_id, purpose: input.purpose ?? null, _semantic_key: `open:${input.occurred_at ?? this.clock()}` },
      { requestId: input.request_id, scanNonce: input.scan_nonce, occurredAt: input.occurred_at, operator: input.operator, temp: input.temp ?? null, offline: input.offline ?? false },
    );
    this.#commit(result);
    return { duplicated: result.duplicated, event: result.envelope };
  }

  /** 封签撤销：未发布结论立即重评，已发布结论产生替代版。 */
  revokeSeal(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    const result = this.#append(
      "aliquot",
      aliquotId,
      "SEAL_REVOKED",
      { seal_id: input.seal_id ?? aliquot.seal_id, reason: input.reason ?? null, _semantic_key: `revoke:${input.seal_id ?? aliquot.seal_id}` },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.operator, temp: input.temp ?? null },
    );
    this.#commit(result);
    if (!result.duplicated) {
      for (const analyte of this.#analytesForSample(aliquot.sample_id)) {
        this.#reevaluate(aliquot.sample_id, analyte, { trigger: "seal_revoked" });
      }
    }
    return { duplicated: result.duplicated, event: result.envelope };
  }

  destroyAliquot(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    assert(aliquot.state !== "destroyed", "invalid_state", "分装管已销毁");
    assert(aliquot.state !== "in_transit", "invalid_state", "在途交接完成前不能销毁");
    const result = this.#append(
      "aliquot",
      aliquotId,
      "ALIQUOT_DESTROYED",
      { method: input.method ?? "autoclave", reason: input.reason ?? null, residual_volume_ml: input.residual_volume_ml ?? null, _semantic_key: `destroy:${input.occurred_at ?? this.clock()}` },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.operator, temp: input.temp ?? null },
    );
    this.#commit(result);
    return { duplicated: result.duplicated, event: result.envelope };
  }

  /**
   * 裁定越过已签节点的离线事件。
   * verdict=accept：事件经审核认可，不构成断点；reject：记为保管断点。
   */
  adjudicate(aliquotId, input) {
    const aliquot = this.#requireAliquot(aliquotId);
    const target = aliquot.events.find((event) => event.event_id === input.event_id && event.payload?.requires_adjudication);
    assert(target, "adjudication_target_not_found", "没有待裁定的离线事件", { status: 404 });
    assert(!aliquot.resolved_event_ids.has(input.event_id), "already_adjudicated", "该事件已裁定", { status: 409 });
    assert(["accept", "reject"].includes(input.verdict), "invalid_verdict", "裁定结论必须是 accept 或 reject", { status: 400 });
    const result = this.#append(
      "aliquot",
      aliquotId,
      "ADJUDICATION_RESOLVED",
      {
        event_id: input.event_id,
        verdict: input.verdict,
        notes: input.notes ?? null,
        _semantic_key: `adjudicate:${input.event_id}`,
      },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.reviewer },
    );
    this.#commit(result);
    if (!result.duplicated) {
      for (const analyte of this.#analytesForSample(aliquot.sample_id)) {
        this.#reevaluate(aliquot.sample_id, analyte, { trigger: `adjudication_${input.verdict}` });
      }
    }
    return { duplicated: result.duplicated, event: result.envelope };
  }

  // ------------------------------------------------------------- 检测批次与结果

  registerBatch(input) {
    const batchId = input.batch_id ?? newId("B");
    for (const aliquotId of input.aliquot_ids ?? []) {
      const aliquot = this.#requireAliquot(aliquotId);
      assert(aliquot.state !== "destroyed", "aliquot_destroyed", `分装管 ${aliquotId} 已销毁，不能入批`);
    }
    const result = this.#append(
      "batch",
      batchId,
      "BATCH_REGISTERED",
      {
        lab: input.lab,
        aliquot_ids: input.aliquot_ids ?? [],
        method_id: input.method_id ?? null,
        _semantic_key: `register:${batchId}`,
      },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.operator ?? input.lab },
    );
    this.#commit(result);
    return { batch: this.batches.get(result.envelope.entity_id), duplicated: result.duplicated, event: result.envelope };
  }

  recordResult(batchId, input) {
    const batch = this.batches.get(batchId);
    assert(batch, "batch_not_found", "检测批次不存在", { status: 404 });
    const aliquot = this.#requireAliquot(input.aliquot_id);
    assert(batch.aliquot_ids.includes(input.aliquot_id), "aliquot_not_in_batch", "该分装管不在此检测批次中", { status: 409 });
    assert(aliquot.state !== "destroyed", "aliquot_destroyed", "分装管已销毁，不能检测", { status: 409 });
    assert(input.method?.id && input.method.version !== undefined, "method_version_required", "结果必须保留方法标识与版本", { status: 400 });
    assert(input.threshold?.analyte, "threshold_required", "结果必须记录判定阈值（含分析物）", { status: 400 });
    assert(this.results.size < Number.MAX_SAFE_INTEGER, "too_many_results", "结果数量超出限制");

    const resultId = input.result_id ?? newId("R");
    const analyte = input.analyte ?? input.threshold.analyte;
    const priorResults = [...this.results.values()].filter(
      (r) => r.sample_id === aliquot.sample_id && r.analyte === analyte && !r.voided,
    );
    const late = input.late ?? (input.retest_of !== undefined && priorResults.length > 0);

    const result = this.#append(
      "result",
      resultId,
      "RESULT_RECORDED",
      {
        batch_id: batchId,
        aliquot_id: aliquot.id,
        sample_id: aliquot.sample_id,
        lab: input.lab ?? batch.lab,
        analyte,
        method: input.method,
        threshold: input.threshold,
        value: input.value ?? null,
        unit: input.unit ?? null,
        qualitative: input.qualitative ?? (input.value !== undefined ? qualitativeCall({ ...input, analyte }) : null),
        uncertainty: input.uncertainty ?? null,
        qc: input.qc ?? [],
        retest_of: input.retest_of ?? null,
        late,
        _semantic_key: `result:${batchId}:${aliquot.id}:${analyte}:${input.occurred_at ?? ""}`,
      },
      { requestId: input.request_id, occurredAt: input.analyzed_at, operator: input.analyst ?? input.lab ?? batch.lab, temp: input.temp ?? null },
    );
    this.#commit(result);

    if (!result.duplicated) {
      // 在分装管链路上补一笔检测事件，保证管的谱系覆盖"检测"环节。
      const tested = this.#append(
        "aliquot",
        aliquot.id,
        "TESTED",
        { batch_id: batchId, result_id: resultId, lab: batch.lab, _semantic_key: `tested:${resultId}` },
        { requestId: undefined, occurredAt: input.analyzed_at, operator: input.analyst ?? batch.lab, temp: input.temp ?? null },
      );
      this.#commit(tested);
      this.#reevaluate(aliquot.sample_id, analyte, { trigger: late ? "late_retest" : "result_recorded" });
    }
    return { result: this.results.get(result.envelope.entity_id), duplicated: result.duplicated, event: result.envelope };
  }

  /** 方法更正：只重评未发布结论；结论已发布则生成替代版。 */
  correctResult(resultId, input) {
    const result = this.results.get(resultId);
    assert(result, "result_not_found", "结果不存在", { status: 404 });
    const changes = {};
    for (const field of RESULT_FIELDS) {
      if (input[field] !== undefined) changes[field] = input[field];
    }
    assert(Object.keys(changes).length > 0, "no_changes", "更正至少包含一个可更正字段", { status: 400 });
    const record = this.#append(
      "result",
      resultId,
      "RESULT_CORRECTED",
      { changes, reason: input.reason ?? null, _semantic_key: `correction:${resultId}:${input.occurred_at ?? this.clock()}` },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.corrected_by },
    );
    this.#commit(record);
    if (!record.duplicated) {
      this.#reevaluate(result.sample_id, result.analyte, { trigger: "method_correction" });
    }
    return { result: this.results.get(resultId), duplicated: record.duplicated, event: record.envelope };
  }

  // ------------------------------------------------------------- 结论

  #analytesForSample(sampleId) {
    const set = new Set();
    for (const result of this.results.values()) {
      if (result.sample_id === sampleId && !result.voided) set.add(result.analyte);
    }
    return [...set];
  }

  #resultsFor(sampleId, analyte) {
    return [...this.results.values()].filter(
      (r) => r.sample_id === sampleId && r.analyte === analyte && !r.voided && !r.retest_superseded,
    );
  }

  #aliquotsForSample(sampleId) {
    return [...this.aliquots.values()].filter((a) => a.sample_id === sampleId);
  }

  /** 汇总样本链路上全部污染指征、链不可信断点与待裁定事件。 */
  #custodyContext(sampleId) {
    const contamination = [];
    const chainBreaks = [];
    const adjudicationPending = [];
    const sample = this.samples.get(sampleId);
    for (const event of sample.events) {
      if (event.payload?.cold_chain && !event.payload.cold_chain.acceptable) {
        chainBreaks.push({ type: "temperature_excursion", scope: "sample", event_id: event.event_id, at: event.occurred_at });
      }
    }
    for (const aliquot of this.#aliquotsForSample(sampleId)) {
      for (const event of aliquot.events) {
        if (event.payload?.requires_adjudication && !aliquot.resolved_event_ids.has(event.event_id)) {
          adjudicationPending.push(event.event_id);
        }
        if (event.type === "SEAL_REVOKED") {
          chainBreaks.push({ type: "seal_revoked", aliquot_id: aliquot.id, event_id: event.event_id, at: event.occurred_at, detail: event.payload.reason });
        }
        if (event.type === "HANDOVER_OVERDUE") {
          const handover = aliquot.handovers.find((h) => h.id === event.payload.handover_id);
          if (handover?.state === "pending") {
            chainBreaks.push({ type: "handover_overdue", aliquot_id: aliquot.id, event_id: event.event_id });
          }
        }
        if (event.type === "ADJUDICATION_RESOLVED" && event.payload.verdict === "reject") {
          chainBreaks.push({ type: "offline_event_rejected", aliquot_id: aliquot.id, event_id: event.payload.event_id, at: event.occurred_at });
        }
        for (const item of event.payload?.breaks ?? []) {
          if (item.type === "offline_out_of_order") {
            if (!aliquot.resolved_event_ids.has(event.event_id)) adjudicationPending.push(event.event_id);
            continue;
          }
          const entry = { ...item, aliquot_id: aliquot.id, event_id: event.event_id, at: event.occurred_at };
          if (item.type === "seal_compromised") contamination.push(entry);
          else chainBreaks.push(entry);
        }
      }
    }
    return {
      contamination: dedupeBreaks(contamination),
      chainBreaks: dedupeBreaks(chainBreaks),
      adjudicationPending: [...new Set(adjudicationPending)],
    };
  }

  /**
   * 重评（sample, analyte）对应结论。
   * - 不存在结论：提出 v1 提议；
   * - 最新版未发布：在同一实体链上追加新版本；
   * - 最新版已确认（发布）：旧版标记被替代，创建替代版实体等待研究员重新确认。
   */
  #reevaluate(sampleId, analyte, reason) {
    const results = this.#resultsFor(sampleId, analyte).map(publicResult);
    const custody = this.#custodyContext(sampleId);
    const evaluation = evaluateConclusion(results, custody);
    const retestDueAt = evaluation.decision === "needs_retest"
      ? new Date(new Date(this.clock()).getTime() + this.retestDueMs).toISOString()
      : null;

    const currentId = this.conclusionIndex.get(`${sampleId}|${analyte}`);
    const current = currentId ? this.conclusions.get(currentId) : null;

    // 尚未收到任何有效结果前不产生结论，避免把链事件误判成"无结果待复测"。
    if (!current && results.length === 0) return null;

    if (!current) {
      const id = newId("C");
      const record = this.#append(
        "conclusion",
        id,
        "CONCLUSION_PROPOSED",
        {
          sample_id: sampleId,
          analyte,
          version: 1,
          evaluation,
          retest_due_at: retestDueAt,
          triggered_by: reason,
          _semantic_key: "proposed",
        },
        { operator: "system" },
      );
      this.#commit(record);
      return this.conclusions.get(id);
    }

    if (current.status === "proposed") {
      // 结论本身（判定与理由）没有变化时不升版本：重复扫码、重复重评不制造新版本，
      // 只在判定真正改变时原地重评未发布结论。
      if (sameEvaluation(current.evaluation, evaluation)) return current;
      const record = this.#append(
        "conclusion",
        current.id,
        "CONCLUSION_REEVALUATED",
        {
          version: current.version + 1,
          evaluation,
          retest_due_at: retestDueAt,
          triggered_by: reason,
          _semantic_key: `reeval:${current.version + 1}`,
        },
        { operator: "system" },
      );
      this.#commit(record);
      return this.conclusions.get(current.id);
    }

    // 已发布结论不可改：仅当新证据使判定/理由发生变化时，
    // 旧版标记被替代并新建替代版，重新走确认流程；无实质变化则保留发布版。
    if (sameEvaluation(current.evaluation, evaluation)) return current;

    const replacementId = newId("C");
    const supersede = this.#append(
      "conclusion",
      current.id,
      "CONCLUSION_SUPERSEDED",
      { new_id: replacementId, reason: reason.trigger, _semantic_key: `superseded:${replacementId}` },
      { operator: "system" },
    );
    this.#commit(supersede);
    const propose = this.#append(
      "conclusion",
      replacementId,
      "CONCLUSION_PROPOSED",
      {
        sample_id: sampleId,
        analyte,
        version: current.version + 1,
        supersedes: current.id,
        evaluation,
        retest_due_at: retestDueAt,
        triggered_by: reason,
        _semantic_key: "proposed",
      },
      { operator: "system" },
    );
    this.#commit(propose);
    return this.conclusions.get(replacementId);
  }

  evaluate(sampleId, analyte) {
    this.#requireSample(sampleId);
    assert(analyte, "analyte_required", "必须指定分析物", { status: 400 });
    return this.#reevaluate(sampleId, analyte, { trigger: "manual" });
  }

  /** 研究员确认后，结论才关联到观测窗口（即"发布"）。 */
  confirmConclusion(conclusionId, input) {
    const conclusion = this.conclusions.get(conclusionId);
    assert(conclusion, "conclusion_not_found", "结论不存在", { status: 404 });
    assert(conclusion.status === "proposed", "conclusion_not_proposed", `结论状态为 ${conclusion.status}，不能确认`, { status: 409 });
    assert(input.window_id, "window_required", "研究员确认时必须指定要关联的观测窗口", { status: 400 });
    {
      const window = this.windows.get(input.window_id);
      assert(window, "window_not_found", "观测窗口不存在", { status: 404 });
      assert(window.species_code === conclusion.analyte || window.species_code === null, "window_analyte_mismatch", "观测窗口的物种/分析物与结论不一致", { status: 409 });
    }
    const record = this.#append(
      "conclusion",
      conclusionId,
      "CONCLUSION_CONFIRMED",
      {
        window_id: input.window_id ?? null,
        decision_snapshot: conclusion.evaluation,
        _semantic_key: "confirm",
      },
      { requestId: input.request_id, occurredAt: input.occurred_at, operator: input.reviewer },
    );
    this.#commit(record);
    return this.conclusions.get(conclusionId);
  }

  // ------------------------------------------------------------- 观测窗口

  registerWindow(input) {
    const id = input.window_id ?? newId("W");
    const record = this.#append(
      "window",
      id,
      "WINDOW_REGISTERED",
      {
        project_id: input.project_id ?? null,
        species_code: input.species_code ?? null,
        grid: input.grid ?? null,
        start_at: input.start_at,
        end_at: input.end_at,
        location: input.location ?? null,
        _semantic_key: `register:${id}`,
      },
      { requestId: input.request_id, occurredAt: input.registered_at, operator: input.operator ?? "system" },
    );
    this.#commit(record);
    return this.windows.get(id);
  }

  /**
   * 查询项目观测窗口及其已发布结论。敏感物种位置按查询者的项目角色降精度：
   * 原始坐标不出系统；无项目权限者得到 withhold。
   */
  queryWindows({ project_id, actor } = {}) {
    const policy = project_id ? this.projects.get(project_id) : null;
    const tier = actor && policy ? precisionForActor(policy, actor) : "withhold";

    return [...this.windows.values()]
      .filter((window) => !project_id || window.project_id === project_id)
      .map((window) => {
        const sensitive = isSensitiveSpecies(policy, window.species_code);
        const effectiveTier = sensitive ? tier : "exact";
        const reduced = reducePrecision(window.location, effectiveTier);
        return {
          window_id: window.id,
          project_id: window.project_id,
          species_code: window.species_code,
          sensitive,
          grid: window.grid,
          start_at: window.start_at,
          end_at: window.end_at,
          location: reduced.location,
          location_precision: reduced.precision,
          location_cell: reduced.cell ?? null,
          cell_size: reduced.cell_size ?? null,
          published_links: window.linked.map((link) => {
            const conclusion = this.conclusions.get(link.conclusion_id);
            return {
              conclusion_id: link.conclusion_id,
              sample_id: link.sample_id,
              analyte: link.analyte,
              decision: link.decision,
              approved_by: link.reviewer,
              status: conclusion?.status ?? "confirmed",
              superseded_by: conclusion?.superseded_by ?? null,
            };
          }),
        };
      });
  }

  getProjectPolicy(projectId) {
    return this.projects.get(projectId) ?? null;
  }

  // ------------------------------------------------------------- 待办与恢复

  /**
   * 服务恢复 / 定时巡检：继续超时交接与复测待办。
   * 对超过时限仍未确认的交接追加 OVERDUE 事件（只追加一次）；
   * 对超过复测期限的待复测结论追加 OVERDUE 标记。
   */
  tick(nowIso = this.clock()) {
    const now = new Date(nowIso).getTime();
    const actions = [];

    for (const aliquot of this.aliquots.values()) {
      for (const handover of aliquot.handovers) {
        if (handover.state === "pending" && !handover.overdue && handover.due_at && new Date(handover.due_at).getTime() <= now) {
          const record = this.#append(
            "aliquot",
            aliquot.id,
            "HANDOVER_OVERDUE",
            { handover_id: handover.id, _semantic_key: `overdue:${handover.id}` },
            { operator: "system", occurredAt: nowIso },
          );
          this.#commit(record);
          if (!record.duplicated) {
            actions.push({ type: "handover_overdue", handover_id: handover.id, aliquot_id: aliquot.id });
            for (const analyte of this.#analytesForSample(aliquot.sample_id)) {
              this.#reevaluate(aliquot.sample_id, analyte, { trigger: "handover_overdue" });
            }
          }
        }
      }
    }

    for (const conclusion of this.conclusions.values()) {
      if (
        conclusion.status === "proposed"
        && conclusion.decision === "needs_retest"
        && conclusion.retest_due_at
        && !conclusion.overdue_marked
        && new Date(conclusion.retest_due_at).getTime() <= now
      ) {
        const record = this.#append(
          "conclusion",
          conclusion.id,
          "CONCLUSION_RETEST_OVERDUE",
          { due_at: conclusion.retest_due_at, _semantic_key: `retest-overdue:${conclusion.id}:${conclusion.version}` },
          { operator: "system", occurredAt: nowIso },
        );
        this.#commit(record);
        if (!record.duplicated) actions.push({ type: "retest_overdue", conclusion_id: conclusion.id });
      }
    }
    return actions;
  }

  getTodos(nowIso = this.clock()) {
    const now = new Date(nowIso).getTime();
    const todos = [];
    for (const aliquot of this.aliquots.values()) {
      for (const handover of aliquot.handovers) {
        if (handover.state === "pending") {
          todos.push({
            type: "handover_acceptance",
            handover_id: handover.id,
            aliquot_id: aliquot.id,
            expected_receiver: handover.expected_receiver,
            due_at: handover.due_at,
            overdue: Boolean(handover.due_at && new Date(handover.due_at).getTime() <= now),
          });
        }
      }
    }
    for (const conclusion of this.conclusions.values()) {
      if (conclusion.status === "proposed" && conclusion.decision === "needs_retest") {
        todos.push({
          type: "retest",
          conclusion_id: conclusion.id,
          sample_id: conclusion.sample_id,
          analyte: conclusion.analyte,
          version: conclusion.version,
          due_at: conclusion.retest_due_at,
          overdue: Boolean(conclusion.retest_due_at && new Date(conclusion.retest_due_at).getTime() <= now),
        });
      }
    }
    return todos;
  }

  // ------------------------------------------------------------- 追溯

  /** 从一条结论追回：所用样本、分装管谱系、保管断点、质控证据与批准人。 */
  trace(conclusionId) {
    const conclusion = this.conclusions.get(conclusionId);
    assert(conclusion, "conclusion_not_found", "结论不存在", { status: 404 });

    const versionChain = [];
    let cursor = conclusion;
    while (cursor) {
      versionChain.unshift(publicConclusion(cursor));
      cursor = cursor.supersedes ? this.conclusions.get(cursor.supersedes) : null;
    }
    for (const successor of this.conclusions.values()) {
      if (successor.supersedes === conclusionId && !versionChain.some((item) => item.id === successor.id)) {
        versionChain.push(publicConclusion(successor));
      }
    }

    const sample = this.samples.get(conclusion.sample_id);
    const aliquots = this.#aliquotsForSample(conclusion.sample_id);
    const results = this.#resultsFor(conclusion.sample_id, conclusion.analyte);
    const custody = this.#custodyContext(conclusion.sample_id);

    const qcEvidence = results.flatMap((result) =>
      (result.qc ?? []).map((control) => ({
        result_id: result.id,
        lab: result.lab,
        method: result.method,
        control,
      })),
    );

    const approvals = [];
    for (const id of unique(versionChain.map((item) => item.conclusion_id))) {
      const entity = this.conclusions.get(id);
      const confirmed = entity.events.find((event) => event.type === "CONCLUSION_CONFIRMED");
      if (confirmed) {
        approvals.push({
          conclusion_id: id,
          version: entity.version,
          reviewer: confirmed.operator,
          at: confirmed.occurred_at,
          window_id: confirmed.payload.window_id,
        });
      }
    }

    return {
      conclusion: publicConclusion(conclusion),
      versions: versionChain,
      sample: sample && {
        id: sample.id,
        project_id: sample.project_id,
        site: sample.site,
        matrix: sample.matrix,
        collected_at: sample.collected_at,
        collector: sample.collector,
        state: sample.state,
      },
      lineage: aliquots.map((aliquot) => ({
        aliquot_id: aliquot.id,
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
          breaks: event.payload?.breaks ?? [],
          requires_adjudication: event.payload?.requires_adjudication ?? false,
          resolved: aliquot.resolved_event_ids.has(event.event_id),
          content_digest: event.content_digest,
        })),
      })),
      results: results.map(publicResult),
      custody_breaks: [...custody.contamination.map((b) => ({ ...b, severity: "contamination" })), ...custody.chainBreaks.map((b) => ({ ...b, severity: "chain" }))],
      adjudication_pending: custody.adjudicationPending,
      qc_evidence: qcEvidence,
      approvals,
    };
  }

  #requireSample(id) {
    const sample = this.samples.get(id);
    assert(sample, "sample_not_found", `样本 ${id} 不存在`, { status: 404 });
    return sample;
  }

  #requireAliquot(id) {
    const aliquot = this.aliquots.get(id);
    assert(aliquot, "aliquot_not_found", `分装管 ${id} 不存在`, { status: 404 });
    return aliquot;
  }
}

function dedupeBreaks(breaks) {
  const seen = new Set();
  return breaks.filter((item) => {
    const key = `${item.type}:${item.event_id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set(values)];
}

/** 判定与依据是否实质相同（版本号、到期时间等登记字段不参与）。 */
function sameEvaluation(a, b) {
  if (!a || !b || a.decision !== b.decision) return false;
  if (a.basis_result_ids.length !== b.basis_result_ids.length) return false;
  const aBasis = new Set(a.basis_result_ids);
  if (b.basis_result_ids.some((id) => !aBasis.has(id))) return false;
  if (JSON.stringify(a.calls ?? {}) !== JSON.stringify(b.calls ?? {})) return false;
  return JSON.stringify([...a.reasons].map(normalizeReason).sort())
    === JSON.stringify([...b.reasons].map(normalizeReason).sort());
}

function normalizeReason(reason) {
  // 去除每次重评可能变化的字段，只比较语义。
  const { event_ids, ...rest } = reason;
  return rest;
}

export function publicResult(result) {
  return {
    result_id: result.id,
    batch_id: result.batch_id,
    aliquot_id: result.aliquot_id,
    lab: result.lab,
    analyte: result.analyte,
    call: qualitativeCall(result),
    value: result.value,
    unit: result.unit,
    qualitative: result.qualitative,
    method: result.method,
    threshold: result.threshold,
    uncertainty: result.uncertainty,
    qc: result.qc,
    analyzed_at: result.analyzed_at,
    retest_of: result.retest_of,
    late: result.late,
    corrections: result.corrections,
  };
}

export function publicConclusion(conclusion) {
  return {
    conclusion_id: conclusion.id,
    sample_id: conclusion.sample_id,
    analyte: conclusion.analyte,
    version: conclusion.version,
    status: conclusion.status,
    decision: conclusion.decision,
    reasons: conclusion.evaluation.reasons,
    basis_result_ids: conclusion.evaluation.basis_result_ids,
    retest_due_at: conclusion.retest_due_at,
    supersedes: conclusion.supersedes ?? null,
    superseded_by: conclusion.superseded_by ?? null,
    reviewer: conclusion.reviewer ?? null,
    window_id: conclusion.window_id ?? null,
    confirmed_at: conclusion.confirmed_at ?? null,
  };
}
