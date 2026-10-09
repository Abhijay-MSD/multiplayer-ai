// An error the caller can act on: an HTTP status, a stable machine-readable
// code, a message written for a person, and optional extra fields (for example
// a suggested name). The REST layer sends all of it; MCP clients get the message.
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const errorBody = (e) => ({ error: e.message, code: e.code ?? "INTERNAL", ...(e.extra ?? {}) });
