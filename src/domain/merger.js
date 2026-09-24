import { Journal } from "./journal.js";
import { Store } from "./store.js";
import { evaluateCluster } from "./evaluator.js";
import { contentFingerprint } from "./crypto.js";
import {
  HANDOVER_TIMEOUT_MS,
  OBSERVATION_WINDOW_MS,
  LOCATION_PRECISION,
  SENSITIVE_TARGETS,
} from "./policy.js";
import { badRequest, notFound, conflict, unprocessable } from "./errors.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw badRequest(`缺少必填字段: ${field}`);
    }
  }
}

function eventFingerprint(data) {
  return contentFingerprint({
    resourceKind: data.resourceKind,
    resourceId: data.resourceId,
    type: data.type,
    occurredAt: data.occurredAt,
    operator: data.operator,
    sealId: data.sealId ?? null,
    temperature: data.temperature ?? null,
    data: data.data ?? null,
  });
}

export class MergerService {
  constructor({ journalFile } = {}) {
    this.journal = new Journal(journalFile);
    this.store = new Store();
    this.journal.verify();
    this.store.replay(this.journal.entries);
  }

  // ---------- 基础资源 ----------

  registerSample(body = {}) {
    requireFields(body, ["siteId", "collectedAt", "operator"]);
    if (!ISO.test(body.collectedAt)) throw badRequest("collectedAt 必须是 ISO-8601 时间");
    if (body.location && (typeof body.location.lat !== "number" || typeof body.location.lng !== "number")) {
      throw badRequest("location 需包含数值型 lat/lng");
    }
    if (body.sampleId && this.store.samples.has(body.sampleId)) {
      throw conflict("sample_exists", `样本 ${body.sampleId} 已存在`);
    }
    const sampleId = body.sampleId ?? this.store.nextId("sample", "S-");
    const sample = {
      sampleId,
      siteId: body.siteId,
      matrix: body.matrix ?? "water",
      collectedAt: body.collectedAt,
      operator: body.operator,
      location: body.location ?? null,
      volumeMl: body.volumeMl ?? null,
      temperature: body.temperature ?? null,
      status: "collected",
      holder: body.operator,
    };
    sample.fingerprint = contentFingerprint({
      siteId: sample.siteId,
      matrix: sample.matrix,
      collectedAt: sample.collectedAt,
      volumeMl: sample.volumeMl,
      temperature: sample.temperature ?? null,
    });
    const event = this._makeEvent({
      resourceKind: "sample",
      resourceId: sampleId,
      type: "collected",
      occurredAt: body.collectedAt,
      operator: body.operator,
      temperature: body.temperature,
      data: { siteId: body.siteId, matrix: sample.matrix, volumeMl: sample.volumeMl },
    });
    event.status = "live";
    this._write("sample_registered", { sample, event });
    return { sample, event };
  }

  registerBatch(body = {}) {
    requireFields(body, ["labId"]);
    if (body.batchId && this.store.batches.has(body.batchId)) {
      throw conflict("batch_exists", `批次 ${body.batchId} 已存在`);
    }
    const batchId = body.batchId ?? this.store.nextId("batch", "B-");
    const batch = {
      batchId,
      labId: body.labId,
      methodId: body.methodId ?? null,
      receivedAt: body.receivedAt ?? new Date().toISOString(),
      sealIds: body.sealIds ?? [],
      note: body.note ?? null,
      status: "registered",
    };
    this._write("batch_registered", { batch });
    return { batch };
  }

  registerMethod(body = {}) {
    requireFields(body, ["code"]);
    if (body.methodId && this.store.methods.has(body.methodId)) {
      throw conflict("method_exists", `方法 ${body.methodId} 已存在`);
    }
    const methodId = body.methodId ?? `M-${body.code}`;
    if (this.store.methods.has(methodId)) throw conflict("method_exists", `方法 ${methodId} 已存在`);
    const firstVersion = body.currentVersion ?? "1.0";
    const version = {
      version: firstVersion,
      registeredAt: new Date().toISOString(),
      changeSummary: "初始版本",
      thresholds: body.thresholds ?? {},
    };
    const method = {
      methodId,
      code: body.code,
      name: body.name ?? body.code,
      currentVersion: firstVersion,
      versions: [version],
    };
    this._write("method_registered", { method });
    return { method };
  }

  /** 方法更正：追加新版本，使用旧版本的结论只重评未发布版，已发布版产生替代版草案。 */
  correctMethod(body = {}) {
    requireFields(body, ["methodId", "version", "operator"]);
    const method = this.store.methods.get(body.methodId);
    if (!method) throw notFound("检测方法");
    if (method.versions.some((v) => v.version === body.version)) {
      throw conflict("method_version_exists", `版本 ${body.version} 已存在`);
    }
    const version = {
      version: body.version,
      registeredAt: new Date().toISOString(),
      changeSummary: body.changeSummary ?? "方法更正",
      thresholds: body.thresholds ?? method.versions[method.versions.length - 1].thresholds,
    };
    this._write("method_corrected", {
      methodId: method.methodId,
      version,
      operator: body.operator,
    });
    const affected = [...this.store.results.values()]
      .filter((r) => r.methodId === method.methodId)
      .map((r) => r.resultId);
    for (const resultId of affected) this._reevaluateResult(resultId, "method_corrected");
    return { method: this.store.methods.get(method.methodId), reevaluatedResults: affected };
  }

  // ---------- 谱系事件 ----------

  /**
   * 追加谱系事件。重复扫码（相同 eventId / 幂等键）返回原事件。
   * 离线补录若越过资源最后已签节点，进入 pending 待裁定；在线越序拒绝。
   */
  appendEvent(body = {}) {
    requireFields(body, ["resourceKind", "resourceId", "type", "occurredAt", "operator"]);
    if (!["sample", "tube", "batch"].includes(body.resourceKind)) {
      throw badRequest("resourceKind 必须是 sample / tube / batch");
    }
    const resource = this.store._resource(body.resourceKind, body.resourceId);
    if (!resource) throw notFound("保管链资源");

    const idem = this._checkIdempotency(body, "event");
    if (idem) return { event: this._eventIdempotencyHit(idem), replayed: true };
    if (body.eventId && this.store.events.has(body.eventId)) {
      return { event: this.store.events.get(body.eventId), replayed: true };
    }

    const event = this._makeEvent({
      resourceKind: body.resourceKind,
      resourceId: body.resourceId,
      type: body.type,
      occurredAt: body.occurredAt,
      operator: body.operator,
      sealId: body.sealId,
      temperature: body.temperature,
      data: body.data ?? {},
      eventId: body.eventId,
      idempotencyKey: body.idempotencyKey,
    });

    if (resource.status === "destroyed" && event.type !== "seal_revoked") {
      if (body.offline) return this._pendEvent(event, body, "resource_destroyed");
      throw conflict("resource_destroyed", "资源已销毁，不能再追加谱系事件");
    }

    // 分装事件的 tubeId 与内容指纹富集与在线状态无关，先完成再判断是否越序，
    // 保证离线挂起事件日后被裁定时载荷也是完整的。
    if (event.type === "aliquoted") {
      this._validateAliquot(event, resource);
    }

    const lastLive = this._lastLiveEvent(body.resourceKind, body.resourceId);
    const crossed = lastLive && new Date(event.occurredAt).getTime() < new Date(lastLive.occurredAt).getTime();
    if (crossed) {
      if (body.offline) return this._pendEvent(event, body, "crossed_signed_node");
      throw conflict("event_out_of_order", "事件时间早于已签节点，离线补录请标记 offline");
    }

    if (event.type === "handed_over") {
      this._validateHandoverEvent(event);
    }

    event.status = "live";
    this._write("event_appended", { event });
    this._rememberIdempotency(body, "event", { event });
    this._afterChainEvent(event);
    return { event, replayed: false };
  }

  _makeEvent(parts) {
    const eventId = parts.eventId ?? this.store.nextId("event", "EV-");
    const base = {
      eventId,
      resourceKind: parts.resourceKind,
      resourceId: parts.resourceId,
      type: parts.type,
      occurredAt: parts.occurredAt,
      operator: parts.operator,
      sealId: parts.sealId ?? null,
      temperature: parts.temperature ?? null,
      data: parts.data ?? {},
      recordedAt: new Date().toISOString(),
      idempotencyKey: parts.idempotencyKey ?? null,
    };
    base.fingerprint = eventFingerprint(base);
    return base;
  }

  _validateAliquot(event, parentResource) {
    const tubes = event.data.tubes;
    if (!Array.isArray(tubes) || tubes.length === 0) {
      throw badRequest("aliquoted 事件需要 data.tubes 列表");
    }
    for (const item of tubes) {
      requireFields(item, ["sealId", "volumeMl"]);
      if ([...this.store.tubes.values()].some((t) => t.sealId === item.sealId)) {
        throw conflict("seal_in_use", `封签 ${item.sealId} 已绑定其他分装管`);
      }
      item.tubeId = item.tubeId ?? this.store.nextId("tube", "T-");
      item.fingerprint = contentFingerprint({
        parentFingerprint: parentResource.fingerprint,
        sealId: item.sealId,
        volumeMl: item.volumeMl,
      });
    }
  }

  _validateHandoverEvent(event) {
    const stage = event.data.stage;
    if (!["sent", "confirmed", "rejected"].includes(stage)) {
      throw badRequest("交接事件 data.stage 必须是 sent / confirmed / rejected");
    }
    if (stage === "sent") {
      requireFields(event.data, ["to"]);
      event.data.handoverId = event.data.handoverId ?? this.store.nextId("handover", "HO-");
      event.data.from = event.data.from ?? event.operator;
      if (!event.sealId && !event.data.sealId) {
        throw badRequest("交接发出必须记录封签 sealId");
      }
      event.sealId = event.sealId ?? event.data.sealId;
      const sameSeal = [...this.store.handovers.values()].find(
        (h) => h.sealId === event.sealId && h.status === "pending"
      );
      if (sameSeal) throw conflict("handover_pending", `封签 ${event.sealId} 已有在途交接`);
    } else {
      const handover = this.store.handovers.get(event.data.handoverId);
      if (!handover) throw unprocessable("handover_unknown", "交接单不存在，无法确认或拒收");
      if (handover.status !== "pending") {
        throw conflict(
          "handover_closed",
          `交接单已处于 ${handover.status} 状态`,
          { handoverId: handover.handoverId, status: handover.status }
        );
      }
      // CAS：同一封签只允许一个接收方确认成功。
      if (stage === "confirmed") {
        event.data.receiver = event.data.receiver ?? event.operator;
        if (event.data.sealIntact === undefined) event.data.sealIntact = true;
      }
      event.sealId = handover.sealId;
    }
  }

  /** 离线越序事件挂起待裁定，并开立裁定待办。 */
  _pendEvent(event, body, reason) {
    event.status = "pending";
    event.pendingReason = reason;
    event.offline = { recordedOffline: true, deviceId: body.offline?.deviceId ?? null };
    this._write("event_pending", { event });
    this._openTodo(`ADJ-${event.eventId}`, {
      kind: "adjudication",
      eventId: event.eventId,
      resourceKind: event.resourceKind,
      resourceId: event.resourceId,
      reason,
      createdAt: new Date().toISOString(),
    });
    return { event, pending: true };
  }

  adjudicateEvent(eventId, body = {}) {
    requireFields(body, ["decision", "operator"]);
    if (!["approved", "rejected"].includes(body.decision)) {
      throw badRequest("decision 必须是 approved / rejected");
    }
    const event = this.store.events.get(eventId);
    if (!event) throw notFound("待裁定事件");
    if (event.status !== "pending") {
      throw conflict("event_adjudicated", `事件已裁定为 ${event.status}`);
    }
    this._write("event_adjudicated", {
      eventId,
      decision: body.decision,
      reason: body.reason ?? null,
      operator: body.operator,
      adjudicatedAt: new Date().toISOString(),
    });
    this._closeTodo(`ADJ-${eventId}`);
    if (body.decision === "approved") {
      const live = this.store.events.get(eventId);
      this._afterChainEvent(live);
    }
    return { event: this.store.events.get(eventId) };
  }

  listPendingEvents() {
    return [...this.store.events.values()].filter((e) => e.status === "pending");
  }

  _lastLiveEvent(kind, id) {
    const ids = this.store.resourceEvents.get(`${kind}:${id}`) ?? [];
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const event = this.store.events.get(ids[i]);
      if (event.status === "live") return event;
    }
    return null;
  }

  /** 封签撤销：作废所有在途交接，相关结论按发布状态决定重评或替代版。 */
  revokeSeal(body = {}) {
    requireFields(body, ["sealId", "operator", "resourceKind", "resourceId"]);
    const resource = this.store._resource(body.resourceKind, body.resourceId);
    if (!resource) throw notFound("保管链资源");
    const event = this._makeEvent({
      resourceKind: body.resourceKind,
      resourceId: body.resourceId,
      type: "seal_revoked",
      occurredAt: body.occurredAt ?? new Date().toISOString(),
      operator: body.operator,
      sealId: body.sealId,
      data: { reason: body.reason ?? null },
    });
    event.status = "live";
    this._write("event_appended", { event });
    const affected = new Set();
    for (const tube of this.store.tubes.values()) {
      if (tube.sealId === body.sealId) {
        for (const result of this.store.results.values()) {
          if (result.tubeId === tube.tubeId) affected.add(result.resultId);
        }
      }
    }
    for (const result of this.store.results.values()) {
      if (result.sampleId === body.resourceId) affected.add(result.resultId);
    }
    for (const resultId of affected) this._reevaluateResult(resultId, "seal_revoked");
    return { event, reevaluatedResults: [...affected] };
  }

  _afterChainEvent(event) {
    if (event.type === "handed_over" && event.data.stage === "sent") {
      this._openTodo(`HO-${event.data.handoverId}`, {
        kind: "handover_timeout",
        handoverId: event.data.handoverId,
        sealId: event.sealId,
        resourceKind: event.resourceKind,
        resourceId: event.resourceId,
        from: event.data.from,
        to: event.data.to,
        sentAt: event.occurredAt,
        createdAt: new Date().toISOString(),
      });
    }
    if (event.type === "handed_over" && ["confirmed", "rejected"].includes(event.data.stage)) {
      let handoverId = event.data.handoverId;
      if (!handoverId) {
        const resolved = [...this.store.handovers.values()].find(
          (h) => h.sealId === event.sealId && h.resourceKind === event.resourceId &&
            h.resourceId === event.resourceId && h.status !== "pending"
        );
        handoverId = resolved?.handoverId;
      }
      if (handoverId) this._closeTodo(`HO-${handoverId}`);
    }
    // 链条变化可能影响已评估结果。
    if (["handed_over", "unsealed", "stored"].includes(event.type)) {
      for (const result of this.store.results.values()) {
        const tube = this.store.tubes.get(result.tubeId);
        if (
          (event.resourceKind === "tube" && result.tubeId === event.resourceId) ||
          (event.resourceKind === "sample" && result.sampleId === event.resourceId) ||
          (tube && tube.sampleId === event.resourceId)
        ) {
          this._reevaluateResult(result.resultId, "chain_event");
        }
      }
    }
  }

  // ---------- 实验室结果与结论 ----------

  recordResult(body = {}) {
    requireFields(body, [
      "labId", "batchId", "tubeId", "sampleId", "target",
      "methodId", "methodVersion", "value", "measuredAt", "operator",
    ]);
    const idem = this._checkIdempotency(body, "result");
    if (idem) {
      const result = idem.payload ? idem.payload.result : this.store.results.get(idem.refId);
      return { result, replayed: true };
    }

    const tube = this.store.tubes.get(body.tubeId);
    if (!tube) throw notFound("分装管");
    const sample = this.store.samples.get(body.sampleId);
    if (!sample) throw notFound("样本");
    if (tube.sampleId !== body.sampleId) throw badRequest("分装管不属于该样本");
    if (!this.store.batches.has(body.batchId)) throw notFound("检测批次");
    const method = this.store.methods.get(body.methodId);
    if (!method) throw notFound("检测方法");
    if (!method.versions.some((v) => v.version === body.methodVersion)) {
      throw unprocessable("method_version_unknown", "方法版本未登记");
    }
    if (tube.status === "destroyed") throw conflict("tube_destroyed", "分装管已销毁");

    const resultId = body.resultId ?? this.store.nextId("result", "R-");
    if (this.store.results.has(resultId)) throw conflict("result_exists", `结果 ${resultId} 已存在`);
    const result = {
      resultId,
      labId: body.labId,
      batchId: body.batchId,
      tubeId: body.tubeId,
      sampleId: body.sampleId,
      siteId: sample.siteId,
      target: body.target,
      methodId: body.methodId,
      methodVersion: body.methodVersion,
      value: body.value,
      unit: body.unit ?? null,
      thresholds: body.thresholds ?? method.versions.find((v) => v.version === body.methodVersion).thresholds,
      uncertainty: body.uncertainty ?? null,
      qc: body.qc ?? {},
      measuredAt: body.measuredAt,
      operator: body.operator,
      retestOfResultId: body.retestOfResultId ?? null,
      recordedAt: new Date().toISOString(),
      idempotencyKey: body.idempotencyKey ?? null,
    };
    result.fingerprint = contentFingerprint({
      labId: result.labId, batchId: result.batchId, tubeId: result.tubeId,
      target: result.target, methodId: result.methodId, methodVersion: result.methodVersion,
      value: result.value, thresholds: result.thresholds, uncertainty: result.uncertainty,
      qc: result.qc, measuredAt: result.measuredAt,
    });

    const event = this._makeEvent({
      resourceKind: "tube",
      resourceId: tube.tubeId,
      type: "tested",
      occurredAt: body.measuredAt,
      operator: body.operator,
      sealId: tube.sealId,
      temperature: body.temperature ?? null,
      data: {
        resultId,
        batchId: body.batchId,
        labId: body.labId,
        target: body.target,
        value: body.value,
      },
    });
    event.status = "live";

    if (body.retestOfResultId && !this.store.results.has(body.retestOfResultId)) {
      throw notFound("被复测结果");
    }
    this._write("result_recorded", { result, event, retestOf: body.retestOfResultId ?? null });
    this._rememberIdempotency(body, "result", { result, event });

    const clusterKey = this.store.clusterKeyOfResult(resultId);
    const conclusion = this._evaluateToConclusion(clusterKey, body.retestOfResultId ? "late_retest" : "result_recorded");
    return { result, event, clusterKey, conclusion: this._conclusionView(conclusion) };
  }

  evaluateConclusion(clusterKey, trigger = "manual") {
    const cluster = this.store.clusterByKey(clusterKey);
    if (!cluster) throw notFound("结果聚簇");
    return { conclusion: this._conclusionView(this._evaluateToConclusion(clusterKey, trigger)) };
  }

  _evaluateToConclusion(clusterKey, trigger) {
    const cluster = this.store.clusterByKey(clusterKey);
    const snapshot = evaluateCluster(cluster, this.store);
    const data = {
      clusterKey,
      category: snapshot.category,
      reasons: snapshot.reasons,
      results: snapshot.results,
      chainBreaks: snapshot.chainBreaks,
      chainGaps: snapshot.chainGaps,
      qcFailures: snapshot.qcFailures,
      distinctLabs: snapshot.distinctLabs,
      methodSignatures: snapshot.methodSignatures,
      evaluatedAt: new Date().toISOString(),
      trigger,
    };
    const key = cluster.key;
    const existing = this.store.conclusions.get(key);
    const current = existing?.versions.find((v) => v.status === "draft" || v.status === "published");
    const published = existing?.versions.find((v) => v.status === "published");

    if (!existing) {
      this._write("conclusion_changed", { key, siteId: cluster.siteId, target: cluster.target, action: "draft", data });
    } else if (published) {
      // 已发布结论不可覆盖：变化产生替代版草案，等待再次确认。
      const last = existing.versions[existing.versions.length - 1];
      const pendingReplacement = existing.versions.find(
        (v) => v.status === "draft" && v.supersedesVersion
      );
      if (pendingReplacement) {
        this._write("conclusion_changed", {
          key, siteId: cluster.siteId, target: cluster.target,
          action: "revised", version: pendingReplacement.version, data,
        });
      } else {
        this._write("conclusion_changed", {
          key, siteId: cluster.siteId, target: cluster.target,
          action: "new_version", data,
        });
      }
      void last;
    } else {
      const draft = existing.versions.find((v) => v.status === "draft");
      this._write("conclusion_changed", {
        key, siteId: cluster.siteId, target: cluster.target,
        action: "revised", version: draft.version, data,
      });
    }

    if (snapshot.category === "needs_retest") {
      this._openTodo(`RT-${key}`, {
        kind: "retest_due",
        clusterKey: key,
        siteId: cluster.siteId,
        target: cluster.target,
        reason: snapshot.reasons[0],
        createdAt: new Date().toISOString(),
      });
    } else {
      this._closeTodo(`RT-${key}`);
    }
    return this.store.conclusions.get(key);
  }

  _reevaluateResult(resultId, trigger) {
    const clusterKey = this.store.clusterKeyOfResult(resultId);
    if (!clusterKey) return;
    const conclusion = this.store.conclusions.get(clusterKey);
    if (!conclusion) return; // 尚未生成结论，录入时自会评估
    this._evaluateToConclusion(clusterKey, trigger);
  }

  /** 研究员确认草案：结论此时才关联到观测窗口，未确认不产生观测。 */
  confirmConclusion(key, body = {}, role = "project_lead") {
    requireFields(body, ["operator"]);
    const conclusion = this.store.conclusions.get(key);
    if (!conclusion) throw notFound("结论");
    const draft = conclusion.versions.find((v) => v.status === "draft");
    if (!draft) throw conflict("no_draft", "没有待确认的结论草案");

    const cluster = this.store.clusterByKey(draft.clusterKey);
    const firstResult = this.store.results.get(cluster.members[0]);
    const sample = this.store.samples.get(firstResult.sampleId);
    const anchor = cluster.anchor;
    const observationId = this.store.nextId("observation", "O-");
    const observation = {
      observationId,
      siteId: cluster.siteId,
      target: cluster.target,
      windowStart: new Date(anchor - OBSERVATION_WINDOW_MS).toISOString(),
      windowEnd: new Date(anchor + OBSERVATION_WINDOW_MS).toISOString(),
      location: sample?.location ?? null,
      category: draft.category,
      conclusionKey: key,
      version: draft.version,
      resultIds: cluster.members,
      confirmedBy: body.operator,
      confirmedAt: new Date().toISOString(),
    };
    this._write("conclusion_changed", {
      key,
      siteId: cluster.siteId,
      target: cluster.target,
      action: "published",
      version: draft.version,
      data: {
        confirmedBy: body.operator,
        confirmedAt: observation.confirmedAt,
        observationId: observation.observationId,
        windowStart: observation.windowStart,
        windowEnd: observation.windowEnd,
      },
      observation,
    });
    this._closeTodo(`RT-${key}`);
    return {
      conclusion: this._conclusionView(this.store.conclusions.get(key), role),
      observation: { ...observation, location: this._redactLocation(observation.location, cluster.target, role) },
    };
  }

  // ---------- 查询与溯源 ----------

  getSample(sampleId) {
    const sample = this.store.samples.get(sampleId);
    if (!sample) throw notFound("样本");
    const tubes = [...this.store.tubes.values()].filter((t) => t.sampleId === sampleId);
    return {
      sample,
      tubes,
      events: this._eventsFor("sample", sampleId),
      handovers: [...this.store.handovers.values()].filter(
        (h) => h.resourceKind === "sample" && h.resourceId === sampleId
      ),
    };
  }

  getTube(tubeId) {
    const tube = this.store.tubes.get(tubeId);
    if (!tube) throw notFound("分装管");
    return {
      tube,
      sample: this.store.samples.get(tube.sampleId),
      events: this._eventsFor("tube", tubeId),
      handovers: [...this.store.handovers.values()].filter(
        (h) => h.resourceKind === "tube" && h.resourceId === tubeId
      ),
      results: [...this.store.results.values()].filter((r) => r.tubeId === tubeId),
    };
  }

  getResult(resultId) {
    const result = this.store.results.get(resultId);
    if (!result) throw notFound("检测结果");
    return {
      result,
      clusterKey: this.store.clusterKeyOfResult(resultId),
      testedEvent: [...this.store.events.values()].find(
        (e) => e.type === "tested" && e.data.resultId === resultId
      ),
    };
  }

  getConclusion(key, role = "project_lead") {
    const conclusion = this.store.conclusions.get(key);
    if (!conclusion) throw notFound("结论");
    return { conclusion: this._conclusionView(conclusion, role) };
  }

  listObservations(role = "project_lead") {
    const observations = [];
    for (const conclusion of this.store.conclusions.values()) {
      const version = conclusion.versions.find((v) => v.status === "published");
      if (!version?.observationId) continue;
      const cluster = this.store.clusterByKey(version.clusterKey);
      const firstResult = this.store.results.get(cluster.members[0]);
      const sample = this.store.samples.get(firstResult.sampleId);
      observations.push({
        observationId: conclusion.observationId,
        siteId: conclusion.siteId,
        target: conclusion.target,
        category: version.category,
        conclusionKey: conclusion.key,
        version: version.version,
        windowStart: version.windowStart,
        windowEnd: version.windowEnd,
        confirmedBy: version.confirmedBy,
        confirmedAt: version.confirmedAt,
        location: this._redactLocation(sample?.location, conclusion.target, role),
      });
    }
    return { observations };
  }

  /** 从一条结论追回：所用样本、分装管、批次、保管断点、质控证据与批准人。 */
  trace(key) {
    const conclusion = this.store.conclusions.get(key);
    if (!conclusion) throw notFound("结论");
    const current = [...conclusion.versions].reverse().find((v) => v.status !== "superseded");
    const cluster = this.store.clusterByKey(current.clusterKey);
    const evidence = [];
    const sampleIds = new Set();
    const tubeIds = new Set();
    const batchIds = new Set();

    for (const resultId of cluster.members) {
      const result = this.store.results.get(resultId);
      if (!result) continue;
      sampleIds.add(result.sampleId);
      tubeIds.add(result.tubeId);
      batchIds.add(result.batchId);
      const method = this.store.methods.get(result.methodId);
      const testedEvent = [...this.store.events.values()].find(
        (e) => e.type === "tested" && e.data.resultId === resultId
      );
      evidence.push({
        result,
        method: method
          ? { methodId: method.methodId, code: method.code, usedVersion: result.methodVersion, currentVersion: method.currentVersion }
          : null,
        testedEvent,
        qc: result.qc,
        uncertainty: result.uncertainty,
        thresholds: result.thresholds,
      });
    }

    const chainEvents = [];
    for (const kindId of [...sampleIds].map((id) => ["sample", id]).concat([...tubeIds].map((id) => ["tube", id]))) {
      chainEvents.push(...this._eventsFor(kindId[0], kindId[1]));
    }

    const published = conclusion.versions.find((v) => v.status === "published")
      ?? conclusion.versions.find((v) => v.status === "superseded");

    return {
      conclusionKey: key,
      currentVersion: current.version,
      currentStatus: current.status,
      category: current.category,
      reasons: current.reasons,
      versions: conclusion.versions.map((v) => ({
        version: v.version,
        status: v.status,
        category: v.category,
        trigger: v.trigger,
        evaluatedAt: v.evaluatedAt,
        confirmedBy: v.confirmedBy ?? null,
        confirmedAt: v.confirmedAt ?? null,
        supersedesVersion: v.supersedesVersion ?? null,
      })),
      samples: [...sampleIds].map((id) => this.store.samples.get(id)),
      tubes: [...tubeIds].map((id) => this.store.tubes.get(id)),
      batches: [...batchIds].map((id) => this.store.batches.get(id)),
      evidence,
      chain: {
        events: chainEvents,
        breaks: current.chainBreaks,
        gaps: current.chainGaps,
      },
      qcFailures: current.qcFailures,
      observation: published?.observationId
        ? {
            observationId: published.observationId,
            windowStart: published.windowStart,
            windowEnd: published.windowEnd,
            approver: published.confirmedBy,
            approvedAt: published.confirmedAt,
          }
        : null,
    };
  }

  // ---------- 待办与恢复 ----------

  listTodos(now = Date.now()) {
    const todos = [...this.store.todos.values()].filter((t) => t.status !== "closed").map((t) => ({ ...t }));
    for (const todo of todos) {
      if (todo.kind === "handover_timeout" && new Date(todo.sentAt).getTime() + HANDOVER_TIMEOUT_MS < now) {
        todo.overdue = true;
      }
    }
    return { todos };
  }

  /** 服务恢复：日志已在构造时重放，这里汇总超时交接、待裁定与待复测待办。 */
  recover(now = Date.now()) {
    const { todos } = this.listTodos(now);
    return {
      replayedEvents: this.store.events.size,
      journalSeq: this.journal.seq,
      overdueHandovers: todos.filter((t) => t.kind === "handover_timeout"),
      pendingAdjudications: todos.filter((t) => t.kind === "adjudication"),
      retestTodos: todos.filter((t) => t.kind === "retest_due"),
    };
  }

  // ---------- 内部工具 ----------

  _eventsFor(kind, id) {
    return (this.store.resourceEvents.get(`${kind}:${id}`) ?? [])
      .map((eventId) => this.store.events.get(eventId));
  }

  _openTodo(todoId, todo) {
    const existing = this.store.todos.get(todoId);
    if (existing && existing.status !== "closed") return;
    this._write("todo_changed", { todoId, todo: { ...todo, status: "open" }, status: "open" });
  }

  _closeTodo(todoId) {
    const existing = this.store.todos.get(todoId);
    if (!existing || existing.status === "closed") return;
    this._write("todo_changed", { todoId, status: "closed", closedAt: new Date().toISOString() });
  }

  _checkIdempotency(body, kind) {
    if (!body.idempotencyKey) return null;
    return this.store.idempotency.get(`${kind}:${body.idempotencyKey}`) ?? null;
  }

  _eventIdempotencyHit(hit) {
    if (hit.payload) return hit.payload.event;
    return this.store.events.get(hit.refId);
  }

  _rememberIdempotency(body, kind, payload) {
    if (!body.idempotencyKey) return;
    this.store.idempotency.set(`${kind}:${body.idempotencyKey}`, { kind, payload });
  }

  _write(type, payload) {
    const entry = this.journal.append(type, payload);
    // 写穿：运行时立即走与重放完全相同的归约器，避免维护第二条状态更新路径。
    this.store.applyEntry(type, payload);
    return entry;
  }

  _conclusionView(conclusion, role = "project_lead") {
    const currentPublished = conclusion.versions.find((v) => v.status === "published");
    return {
      key: conclusion.key,
      siteId: conclusion.siteId,
      target: conclusion.target,
      observationId: conclusion.observationId ?? null,
      versions: conclusion.versions.map((v) => ({
        version: v.version,
        status: v.status,
        category: v.category,
        reasons: v.reasons,
        chainBreaks: v.chainBreaks ?? [],
        chainGaps: v.chainGaps ?? [],
        qcFailures: v.qcFailures ?? [],
        distinctLabs: v.distinctLabs ?? null,
        trigger: v.trigger,
        evaluatedAt: v.evaluatedAt,
        confirmedBy: v.confirmedBy ?? null,
        confirmedAt: v.confirmedAt ?? null,
        supersedesVersion: v.supersedesVersion ?? null,
        supersededBy: v.supersededBy ?? null,
        observationId: v.observationId ?? null,
      })),
      currentDraft: conclusion.versions.find((v) => v.status === "draft")?.version ?? null,
      locationPrecision: SENSITIVE_TARGETS.has(conclusion.target)
        ? LOCATION_PRECISION[role]?.label ?? "withheld"
        : "exact",
    };
  }

  _redactLocation(location, target, role) {
    if (!location) return null;
    if (!SENSITIVE_TARGETS.has(target)) return { ...location, precision: "exact" };
    const rule = LOCATION_PRECISION[role] ?? LOCATION_PRECISION.public;
    if (rule.decimals === null) {
      return { precision: "withheld", reason: "sensitive_species" };
    }
    if (rule.grid === "exact") {
      return { lat: location.lat, lng: location.lng, precision: "exact" };
    }
    const factor = 10 ** rule.decimals;
    return {
      lat: Math.round(location.lat * factor) / factor,
      lng: Math.round(location.lng * factor) / factor,
      precision: rule.label,
    };
  }
}
