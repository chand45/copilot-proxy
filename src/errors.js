export class ProxyError extends Error {
  constructor(status, code, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export function errorBody(error, anthropic = false) {
  if (anthropic) {
    const type = {
      401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
      413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error',
    }[error.status] || (error.status >= 500 ? 'api_error' : 'invalid_request_error');
    return { type: 'error', error: { type, message: error.message } };
  }
  return {
    error: {
      message: error.message,
      type: error.type,
      param: null,
      code: error.code,
    },
  };
}
