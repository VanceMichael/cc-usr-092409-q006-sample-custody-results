/** 领域规则违反，携带 HTTP 状态码与机器可读错误码。 */
export class DomainError extends Error {
  constructor(code, message, { status = 422, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 保管链哈希校验失败：日志被改动或缺行。 */
export class ChainIntegrityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ChainIntegrityError";
    this.code = "chain_integrity";
    this.status = 500;
    this.details = details;
  }
}

export function assert(condition, code, message, options) {
  if (!condition) throw new DomainError(code, message, options);
}
