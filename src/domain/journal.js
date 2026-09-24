import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { contentFingerprint } from "./crypto.js";

/**
 * 只追加事件日志：每条记录携带前一条哈希，形成不可覆盖的哈希链。
 * 写入使用 appendFileSync，单次小写在 POSIX 上为原子追加，
 * 因而“检查—比较—落盘”的 CAS 在单进程内不会被并发请求穿插。
 */
export class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    if (filePath && existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.entries.push(JSON.parse(line));
      }
    }
  }

  get seq() {
    return this.entries.length;
  }

  headHash() {
    return this.entries.length === 0
      ? "0".repeat(64)
      : this.entries[this.entries.length - 1].hash;
  }

  append(type, payload) {
    const entry = {
      seq: this.entries.length + 1,
      type,
      payload,
      payloadHash: contentFingerprint({ type, payload }),
      prevHash: this.headHash(),
      recordedAt: new Date().toISOString(),
    };
    entry.hash = contentFingerprint({
      seq: entry.seq,
      type: entry.type,
      payloadHash: entry.payloadHash,
      prevHash: entry.prevHash,
      recordedAt: entry.recordedAt,
    });
    this.entries.push(entry);
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    }
    return entry;
  }

  /** 重放时校验哈希链与每条载荷指纹，任何篡改或缺失立即抛出。 */
  verify() {
    let prevHash = "0".repeat(64);
    for (const entry of this.entries) {
      if (entry.prevHash !== prevHash) {
        throw new Error(`journal_broken_at_${entry.seq}`);
      }
      // 必须重算载荷指纹，否则直接改 payload 不会被外层 hash 发现。
      if (contentFingerprint({ type: entry.type, payload: entry.payload }) !== entry.payloadHash) {
        throw new Error(`journal_payload_tampered_at_${entry.seq}`);
      }
      const expected = contentFingerprint({
        seq: entry.seq,
        type: entry.type,
        payloadHash: entry.payloadHash,
        prevHash: entry.prevHash,
        recordedAt: entry.recordedAt,
      });
      if (expected !== entry.hash) throw new Error(`journal_tampered_at_${entry.seq}`);
      prevHash = entry.hash;
    }
    return this.entries.length;
  }
}
