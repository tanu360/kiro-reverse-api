/** Typed error thrown by the admin API client for every non-2xx response or network failure. */
export class ApiError extends Error {
  /** HTTP status; 0 = network failure */
  readonly status: number;
  /** body.error, else the text body, else statusText, else 'network' */
  readonly serverMessage: string;
  /** parsed JSON body or null */
  readonly body: unknown;
  /** seconds from Retry-After */
  readonly retryAfter: number | null;
  /** body.index (model-mapping 400s) */
  readonly index: number | null;

  constructor(init: {
    status: number;
    serverMessage: string;
    body?: unknown;
    retryAfter?: number | null;
    index?: number | null;
  }) {
    super(init.serverMessage);
    this.name = "ApiError";
    this.status = init.status;
    this.serverMessage = init.serverMessage;
    this.body = init.body ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.index = init.index ?? null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
