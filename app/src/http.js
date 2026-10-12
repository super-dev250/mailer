/** An error whose message is safe to show to the person using the app. `extra` is merged into the JSON response. */
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
