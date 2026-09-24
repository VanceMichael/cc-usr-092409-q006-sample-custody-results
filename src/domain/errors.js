export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, "validation_error", message, details);
export const notFound = (resource) => new HttpError(404, "not_found", `${resource} 不存在`);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);
export const unprocessable = (code, message, details) => new HttpError(422, code, message, details);
export const forbidden = (message) => new HttpError(403, "forbidden", message);
