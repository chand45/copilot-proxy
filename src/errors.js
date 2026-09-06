export class ProxyError extends Error {
  constructor(status, code, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export function errorBody(error) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: null,
      code: error.code,
    },
  };
}
