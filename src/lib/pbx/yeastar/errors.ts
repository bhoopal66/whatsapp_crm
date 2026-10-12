/**
 * A failed Yeastar P-Series Open API call.
 *
 * Yeastar reports failure in the body, not the status line: every
 * response carries `errcode` (0 = success) and an upper-case `errmsg`,
 * and the docs never show the HTTP status of a failure. So callers
 * branch on `errcode`; `httpStatus` is kept for diagnosis only.
 * Shaped like `MetaError`: plain fields plus capability getters, so call
 * sites never compare vendor codes inline.
 *
 * `errcode` is null when the PBX never answered with an envelope at all:
 * a timeout, a network failure, or a body that is not Yeastar JSON (a
 * reverse proxy's HTML error page).
 */
export class YeastarError extends Error {
  readonly errcode: number | null;
  readonly errmsg: string;
  readonly httpStatus: number | null;
  readonly endpoint: string;
  /**
   * The parsed failure body (`invalid_param_list`, `submsg`, ...). Tokens
   * only ever appear in success bodies, so this is safe to log.
   */
  readonly response: Record<string, unknown> | null;

  constructor(init: {
    endpoint: string;
    errcode: number | null;
    errmsg: string;
    httpStatus?: number | null;
    response?: Record<string, unknown> | null;
    detail?: string;
  }) {
    const code = init.errcode === null ? '' : ` (errcode ${init.errcode})`;
    const detail = init.detail ? `: ${init.detail}` : '';
    super(`Yeastar ${init.endpoint} failed: ${init.errmsg}${code}${detail}`);
    this.name = 'YeastarError';
    this.endpoint = init.endpoint;
    this.errcode = init.errcode;
    this.errmsg = init.errmsg;
    this.httpStatus = init.httpStatus ?? null;
    this.response = init.response ?? null;
  }

  /** 10004 TOKEN EXPIRED: drop the token, mint a new one, retry once. */
  get isTokenExpired(): boolean {
    return this.errcode === 10004;
  }

  /**
   * Bad Client ID / Client Secret. Yeastar answers them with the generic
   * -1 FAILURE plus `invalid_param_list: [{ field: 'username or
   * password' }]`, so -1 counts only on `get_token` or with that field.
   * Never retried: 5 consecutive authentication failures get the
   * caller's IP put on the PBX blocklist, which only an admin can clear.
   */
  get isAuthFailure(): boolean {
    if (this.errcode !== -1) return false;
    if (this.endpoint === 'get_token') return true;
    const list = this.response?.invalid_param_list;
    return (
      Array.isArray(list) &&
      list.some(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          (p as { field?: unknown }).field === 'username or password'
      )
    );
  }

  /**
   * 70004 ACCOUNT IP BLOCKED (after repeated auth failures) or 70087 IP
   * FORBIDDEN (the API's IP allow-list). Neither clears by retrying.
   */
  get isIpBlocked(): boolean {
    return this.errcode === 70004 || this.errcode === 70087;
  }

  /**
   * 70651: with the MP3 recording format the PBX serves one recording
   * download at a time; a second concurrent one is refused.
   */
  get isRecordingDownloadBusy(): boolean {
    return this.errcode === 70651;
  }

  /** 70130 (spelled "CAHNNEL ID NOT FOUND" by the PBX): the leg is gone. */
  get isChannelNotFound(): boolean {
    return this.errcode === 70130;
  }

  /**
   * The feature is off on the PBX side: 70123 API UNAVAILABLE, 70656 API
   * FUNCTION IS NOT ENABLED, or 10009 OPERATION FAILED, which the docs
   * attribute to "a disabled feature or insufficient permissions".
   */
  get isFeatureDisabled(): boolean {
    return (
      this.errcode === 70123 || this.errcode === 70656 || this.errcode === 10009
    );
  }
}
