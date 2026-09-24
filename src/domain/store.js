/**
 * 内存状态 + 只追加日志归约器。
 * 运行时每次写操作先落 Journal，再走 applyEntry；启动时重放全部日志，
 * 因此崩溃恢复与正常处理路径完全一致。
 */
export class Store {
  constructor() {
    this.samples = new Map();
    this.tubes = new Map();
    this.batches = new Map();
    this.events = new Map(); // eventId -> 事件（含 pending / void）
    this.resourceEvents = new Map(); // "sample:S1" -> [eventId]
    this.idempotency = new Map(); // 幂等键 -> { kind, id, replayed }
    this.handovers = new Map();
    this.methods = new Map();
    this.results = new Map();
    this.clusters = new Map(); // `${siteId}|${target}` -> [{ key, anchor, members }]
    this.conclusions = new Map(); // key -> { key, siteId, target, versions, drafts: Map? }
    this.todos = new Map();
    this.counters = {
      event: 0, observation: 0, cluster: 0,
      sample: 0, tube: 0, batch: 0, handover: 0, result: 0,
    };
  }

  replay(entries) {
    for (const entry of entries) this.applyEntry(entry.type, entry.payload);
    this._rebuildCounters();
    this._rebuildIdempotency();
  }

  /** 重放后从已落盘 ID 中恢复计数器，避免新 ID 与历史 ID 冲突。 */
  _rebuildCounters() {
    const tail = (id) => {
      const match = /(\d+)$/.exec(id);
      return match ? Number(match[1]) : 0;
    };
    const maxOf = (map) => [...map.keys()].reduce((max, id) => Math.max(max, tail(id)), 0);
    this.counters.sample = maxOf(this.samples);
    this.counters.tube = maxOf(this.tubes);
    this.counters.batch = maxOf(this.batches);
    this.counters.event = maxOf(this.events);
    this.counters.handover = maxOf(this.handovers);
    this.counters.result = maxOf(this.results);
    this.counters.observation = [...this.conclusions.values()]
      .flatMap((c) => c.versions)
      .reduce((max, v) => Math.max(max, tail(v.observationId ?? "")), 0);
    this.counters.cluster = [...this.clusters.values()]
      .flat()
      .reduce((max, c) => Math.max(max, tail(c.key)), 0);
  }

  _rebuildIdempotency() {
    for (const event of this.events.values()) {
      if (event.idempotencyKey) {
        this.idempotency.set(`event:${event.idempotencyKey}`, { kind: "event", refId: event.eventId });
      }
    }
    for (const result of this.results.values()) {
      if (result.idempotencyKey) {
        this.idempotency.set(`result:${result.idempotencyKey}`, { kind: "result", refId: result.resultId });
      }
    }
  }

  applyEntry(type, p) {
    switch (type) {
      case "sample_registered":
        this.samples.set(p.sample.sampleId, { ...p.sample });
        if (p.event) {
          this._indexEvent(p.event);
          this.applyLiveEvent(p.event);
        }
        break;
      case "tubes_created":
        for (const tube of p.tubes) this.tubes.set(tube.tubeId, { ...tube });
        break;
      case "batch_registered":
        this.batches.set(p.batch.batchId, { ...p.batch });
        break;
      case "event_pending":
        this._indexEvent(p.event);
        break;
      case "event_appended":
        this._indexEvent(p.event);
        this.applyLiveEvent(p.event);
        break;
      case "event_adjudicated":
        if (p.decision === "approved") {
          const event = { ...this.events.get(p.eventId), status: "live" };
          this.events.set(p.eventId, event);
          this.applyLiveEvent(event);
        } else {
          const event = { ...this.events.get(p.eventId), status: "void", voidReason: p.reason };
          this.events.set(p.eventId, event);
        }
        break;
      case "method_registered":
        this.methods.set(p.method.methodId, { ...p.method, versions: [...p.method.versions] });
        break;
      case "method_corrected": {
        const method = this.methods.get(p.methodId);
        method.versions.push(p.version);
        method.currentVersion = p.version.version;
        break;
      }
      case "result_recorded":
        this.results.set(p.result.resultId, { ...p.result });
        if (p.event) {
          this._indexEvent(p.event);
          this.applyLiveEvent(p.event);
        }
        this._addToCluster(p.result, p.retestOf);
        break;
      case "conclusion_changed":
        this._applyConclusion(p);
        break;
      case "todo_changed":
        if (p.status === "closed") {
          const todo = this.todos.get(p.todoId);
          if (todo) todo.status = "closed";
        } else {
          this.todos.set(p.todoId, { ...p.todo, todoId: p.todoId });
        }
        break;
      default:
        throw new Error(`unknown_journal_entry:${type}`);
    }
  }

  _indexEvent(event) {
    this.events.set(event.eventId, { ...event });
    const key = `${event.resourceKind}:${event.resourceId}`;
    if (!this.resourceEvents.has(key)) this.resourceEvents.set(key, []);
    this.resourceEvents.get(key).push(event.eventId);
  }

  /** 生效事件对资源状态机的影响。裁定通过时同样走这里。 */
  applyLiveEvent(event) {
    const resource = this._resource(event.resourceKind, event.resourceId);
    switch (event.type) {
      case "aliquoted":
        for (const item of event.data.tubes) {
          this.tubes.set(item.tubeId, {
            tubeId: item.tubeId,
            sampleId: event.resourceKind === "sample" ? event.resourceId : resource.sampleId,
            sealId: item.sealId,
            volumeMl: item.volumeMl,
            fingerprint: item.fingerprint,
            status: "collected",
            holder: event.operator,
          });
        }
        break;
      case "handed_over":
        if (event.data.stage === "sent") {
          this.handovers.set(event.data.handoverId, {
            handoverId: event.data.handoverId,
            sealId: event.sealId,
            resourceKind: event.resourceKind,
            resourceId: event.resourceId,
            from: event.data.from,
            to: event.data.to,
            sentAt: event.occurredAt,
            sentEventId: event.eventId,
            status: "pending",
          });
          if (resource) resource.holder = `transit:${event.data.to}`;
        } else if (event.data.stage === "confirmed" || event.data.stage === "rejected") {
          let handover = this.handovers.get(event.data.handoverId);
          // 离线接收方可能只有封签号：按封签与资源回挂到唯一在途交接单。
          if (!handover) {
            handover = [...this.handovers.values()].find(
              (h) =>
                h.sealId === event.sealId &&
                h.status === "pending" &&
                h.resourceKind === event.resourceKind &&
                h.resourceId === event.resourceId
            );
          }
          if (!handover) return; // 找不到在途交接单（已被撤销等），不改变状态。
          if (event.data.stage === "confirmed") {
            Object.assign(handover, {
              status: "confirmed",
              receiver: event.data.receiver,
              confirmedAt: event.occurredAt,
              confirmedEventId: event.eventId,
              sealIntact: event.data.sealIntact,
            });
            if (resource) resource.holder = event.data.to ?? handover.to;
          } else {
            Object.assign(handover, { status: "rejected", rejectedAt: event.occurredAt });
            if (resource) resource.holder = event.data.from ?? handover.from;
          }
        }
        break;
      case "stored":
        if (resource) {
          resource.status = "stored";
          resource.storageLocation = event.data.location;
        }
        break;
      case "unsealed":
        if (resource) resource.status = "unsealed";
        break;
      case "tested":
        if (resource) {
          resource.status = "tested";
          resource.lastTestedAt = event.occurredAt;
        }
        break;
      case "destroyed":
        if (resource) resource.status = "destroyed";
        break;
      case "seal_revoked": {
        if (resource) resource.sealRevoked = true;
        for (const handover of this.handovers.values()) {
          if (handover.sealId === event.sealId && handover.status === "pending") {
            handover.status = "revoked";
          }
        }
        break;
      }
      default:
        break;
    }
  }

  _resource(kind, id) {
    if (kind === "sample") return this.samples.get(id);
    if (kind === "tube") return this.tubes.get(id);
    if (kind === "batch") return this.batches.get(id);
    return undefined;
  }

  _addToCluster(result, retestOfResultId) {
    const sample = this.samples.get(result.sampleId);
    const siteId = sample?.siteId ?? result.siteId;
    const groupKey = `${siteId}|${result.target}`;
    if (!this.clusters.has(groupKey)) this.clusters.set(groupKey, []);
    const clusters = this.clusters.get(groupKey);
    const collectedAt = new Date(sample?.collectedAt ?? result.measuredAt).getTime();

    let cluster;
    if (retestOfResultId) {
      // 复测结果并入被复测结果所在的聚簇，与迟到复测保持同一结论线索。
      cluster = clusters.find((c) => c.members.includes(retestOfResultId));
    }
    if (!cluster) {
      const windowMs = 30 * 60 * 1000;
      cluster = clusters.find(
        (c) => Math.abs(c.anchor - collectedAt) <= windowMs
      );
    }
    if (!cluster) {
      this.counters.cluster += 1;
      cluster = {
        key: `CL-${siteId}-${result.target}-${this.counters.cluster}`,
        siteId,
        target: result.target,
        anchor: collectedAt,
        members: [],
      };
      clusters.push(cluster);
    }
    if (!cluster.members.includes(result.resultId)) cluster.members.push(result.resultId);
  }

  clusterKeyOfResult(resultId) {
    for (const clusters of this.clusters.values()) {
      for (const cluster of clusters) {
        if (cluster.members.includes(resultId)) return cluster.key;
      }
    }
    return null;
  }

  clusterByKey(key) {
    for (const clusters of this.clusters.values()) {
      const found = clusters.find((c) => c.key === key);
      if (found) return found;
    }
    return null;
  }

  _applyConclusion(p) {
    let conclusion = this.conclusions.get(p.key);
    if (!conclusion) {
      conclusion = { key: p.key, siteId: p.siteId, target: p.target, versions: [] };
      this.conclusions.set(p.key, conclusion);
    }
    if (p.action === "draft") {
      conclusion.versions.push({ version: 1, status: "draft", ...p.data });
    } else if (p.action === "revised") {
      const draft = conclusion.versions.find((v) => v.status === "draft");
      Object.assign(draft, p.data);
    } else if (p.action === "new_version") {
      const version = conclusion.versions.length + 1;
      const current = conclusion.versions.find((v) => v.status === "published");
      if (current) current.supersededBy = version;
      conclusion.versions.push({ version, status: "draft", supersedesVersion: current?.version, ...p.data });
    } else if (p.action === "published") {
      const version = conclusion.versions.find((v) => v.version === p.version);
      version.status = "published";
      Object.assign(version, p.data);
      for (const other of conclusion.versions) {
        if (other !== version && other.status === "published") other.status = "superseded";
      }
      conclusion.observationId = p.observation.observationId;
    }
  }

  nextId(kind, prefix) {
    this.counters[kind] += 1;
    return `${prefix}${this.counters[kind]}`;
  }
}
