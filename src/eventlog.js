import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChainIntegrityError } from "./errors.js";
import { fingerprint, sha256Hex, stableStringify } from "./crypto.js";

const GENESIS = "0".repeat(64);

/**
 * 计算事件信封的链哈希。哈希覆盖事件的全部业务字段与前序哈希，
 * 但不包含 hash 自身。任何对历史事件的删改都会导致后续校验失败。
 */
export function hashEnvelope(envelope) {
  const basis = {
    event_id: envelope.event_id,
    request_id: envelope.request_id ?? null,
    seq: envelope.seq,
    entity_type: envelope.entity_type,
    entity_id: envelope.entity_id,
    type: envelope.type,
    occurred_at: envelope.occurred_at,
    recorded_at: envelope.recorded_at,
    operator: envelope.operator,
    offline: envelope.offline ?? false,
    temp: envelope.temp ?? null,
    payload: envelope.payload,
    prev_hash: envelope.prev_hash,
  };
  return sha256Hex(stableStringify(basis));
}

/**
 * 仅追加（append-only）的保管链事件日志。
 *
 * - 每个实体（现场样本 / 分装管 / 检测批次）各维护一条哈希链，链头指针存内存；
 * - 日志文件内 seq 全局单调递增，append 为同步写，单线程事件循环下天然串行；
 * - request_id 去重表保证重复扫码 / 重试请求幂等；
 * - 启动重放时逐行验证链哈希与内容指纹，发现篡改或缺行抛出 ChainIntegrityError。
 */
export class EventLog {
  constructor({ dir = join(process.cwd(), "data"), clock = () => new Date().toISOString() } = {}) {
    this.dir = dir;
    this.clock = clock;
    this.file = join(dir, "chain.jsonl");
    this.seq = 0;
    /** @type {Map<string, string>} 实体 ID -> 最新事件哈希 */
    this.heads = new Map();
    /** @type {Map<string, string>} request_id -> event_id（幂等索引） */
    this.requestIndex = new Map();
    /** @type {Map<string, string>} 内容指纹 -> event_id（同物理动作去重） */
    this.fingerprintIndex = new Map();
    this.events = [];
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** 重放日志并完成校验，服务启动时必须先调用。 */
  load() {
    this.seq = 0;
    this.heads.clear();
    this.requestIndex.clear();
    this.fingerprintIndex.clear();
    this.events = [];
    if (!existsSync(this.file)) return this;

    const lines = readFileSync(this.file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let envelope;
      try {
        envelope = JSON.parse(trimmed);
      } catch (error) {
        throw new ChainIntegrityError(`事件日志第 ${index + 1} 行无法解析`, { line: index + 1 });
      }
      this.#verifyEnvelope(envelope, index + 1);

      if (envelope.seq !== this.seq + 1) {
        throw new ChainIntegrityError(`事件日志第 ${index + 1} 行序号断裂`, {
          line: index + 1,
          expected: this.seq + 1,
          got: envelope.seq,
        });
      }
      this.seq = envelope.seq;
      this.heads.set(envelope.entity_id, envelope.hash);
      this.events.push(envelope);
      if (envelope.request_id) this.requestIndex.set(envelope.request_id, envelope.event_id);
      if (envelope.payload?._dedup_key) {
        this.fingerprintIndex.set(envelope.payload._dedup_key, envelope.event_id);
      }
    }
    return this;
  }

  #verifyEnvelope(envelope, line) {
    const expectedPrev = this.heads.get(envelope.entity_id) ?? GENESIS;
    if (envelope.prev_hash !== expectedPrev) {
      throw new ChainIntegrityError(`事件日志第 ${line} 行保管链断裂（前序哈希不符）`, {
        line,
        entity_id: envelope.entity_id,
      });
    }
    if (hashEnvelope(envelope) !== envelope.hash) {
      throw new ChainIntegrityError(`事件日志第 ${line} 行哈希校验失败，内容可能被改动`, {
        line,
        entity_id: envelope.entity_id,
      });
    }
    if (envelope.payload?._dedup_key && envelope.content_digest) {
      // 内容指纹与载荷一致即可，登记字段不参与指纹。
      const recomputed = fingerprint(this.#stripEnvelope(envelope.payload));
      if (recomputed !== envelope.content_digest) {
        throw new ChainIntegrityError(`事件日志第 ${line} 行内容指纹不符`, { line });
      }
    }
  }

  #stripEnvelope(payload) {
    const { _dedup_key, ...rest } = payload;
    return rest;
  }

  /**
   * 追加一个事件。
   *
   * @param {object} entry
   * @param {string} entry.request_id 调用方幂等键（扫码事务号），重复提交直接返回已记录事件
   * @returns {{envelope: object, duplicated: boolean}}
   */
  append(entry) {
    if (entry.request_id && this.requestIndex.has(entry.request_id)) {
      const originalId = this.requestIndex.get(entry.request_id);
      const original = this.events.find((event) => event.event_id === originalId);
      return { envelope: original, duplicated: true };
    }

    const seq = this.seq + 1;
    const inputPayload = entry.payload ?? {};
    const dedupKey = inputPayload._dedup_key ?? null;
    // 登记性的去重键不参与内容指纹，但仍随载荷持久化用于重放重建索引。
    const payload = { ...inputPayload };
    let contentDigest = null;
    if (dedupKey) {
      contentDigest = fingerprint(this.#stripEnvelope(payload));
      // 同一物理动作（同扫码指纹）即使换了 request_id 也只接受一次。
      if (this.fingerprintIndex.has(dedupKey)) {
        const originalId = this.fingerprintIndex.get(dedupKey);
        const original = this.events.find((event) => event.event_id === originalId);
        return { envelope: original, duplicated: true };
      }
    }

    const envelope = {
      event_id: randomUUID(),
      request_id: entry.request_id ?? null,
      seq,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      type: entry.type,
      occurred_at: entry.occurred_at,
      recorded_at: this.clock(),
      operator: entry.operator,
      offline: entry.offline ?? false,
      temp: entry.temp ?? null,
      payload,
      content_digest: contentDigest,
      prev_hash: this.heads.get(entry.entity_id) ?? GENESIS,
    };
    // 保持 _dedup_key: null 不参与指纹时载荷干净：上面指纹已用剥离后的值计算。
    envelope.hash = hashEnvelope(envelope);

    appendFileSync(this.file, `${JSON.stringify(envelope)}\n`);
    this.seq = seq;
    this.heads.set(entry.entity_id, envelope.hash);
    this.events.push(envelope);
    if (entry.request_id) this.requestIndex.set(entry.request_id, envelope.event_id);
    if (payload._dedup_key) this.fingerprintIndex.set(payload._dedup_key, envelope.event_id);
    return { envelope, duplicated: false };
  }

  /** 实体的全部保管链事件（按链顺序）。 */
  history(entityId) {
    return this.events.filter((event) => event.entity_id === entityId);
  }

  /**
   * 归档当前日志（用于自检/运维），返回归档路径。正常业务路径不调用，
   * 仅追加语义意味着事件永远不会被覆盖或删除。
   */
  archive() {
    const target = join(this.dir, `chain-${this.seq}.jsonl`);
    renameSync(this.file, target);
    return target;
  }
}
