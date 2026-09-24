import { createHash } from "node:crypto";

/** 稳定序列化：对象键递归排序，保证两端对同一内容算出同一指纹。 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function sha256(message) {
  return createHash("sha256").update(message).digest("hex");
}

/** 内容指纹：对事件载荷或样本内容做规范化哈希。 */
export function contentFingerprint(payload) {
  return sha256(canonicalize(payload));
}
