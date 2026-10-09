// An error that becomes an HTTP response: throw new HttpError(404, 'Campaign not found.')
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The JSON body as a plain object ({} when the body is missing or not an object).
export function bodyOf(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}
