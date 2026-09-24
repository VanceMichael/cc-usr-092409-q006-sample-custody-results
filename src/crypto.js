import { createHash } from "node:crypto";

/**
 * 稳定序列化：对象键排序后 JSON 序列化，保证同一内容始终得到同一指纹，
 * 不依赖对象键的插入顺序。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 内容指纹：对去除登记性字段（事件序号、前序哈希等）后的载荷计算哈希。
 * 指纹用于识别"同一物理动作的重复扫码"以及检测内容是否被事后改动。
 */
export function fingerprint(payload) {
  return sha256Hex(stableStringify(payload));
}

/** 当前时间，允许通过 clock 注入以便测试。 */
export function defaultClock() {
  return new Date().toISOString();
}
