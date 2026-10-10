/**
 * Gateway around @typesafe-ai/sdk. Never throws to callers: every call returns
 * either { ok: true, ... } or { ok: false, errorCode }, so each check can fall
 * back to today's wacrm behaviour.
 *
 * Failure handling (spec §9.1):
 *  - Outage-class failures (timeout, connection, 5xx, 529) feed a per-check
 *    circuit breaker: opens after N failures inside the window (successes
 *    do NOT reset it). One key serves every tenant, so an outage is global.
 *  - Content-class failures (400, 422, a malformed response) can be caused
 *    by one request's content, so they are counted per (check, account):
 *    one tenant's odd traffic never pauses another tenant's guardrail.
 *    3 consecutive 422s pause that check for that account.
 *  - 401/403: every check stops; re-probed after authCooldownMs; alert each time.
 *  - 429: every check waits out the server's Retry-After (capped), once.
 *  - The request is refused locally, without a call, when an identifier
 *    survived redaction (PII_BLOCKED) or the state exceeds the size budget
 *    (STATE_TOO_LARGE). Neither counts as a failure of the service.
 *  - Hard deadline per call covers retries and Retry-After waits.
 *  - Responses are shape-checked; a malformed response is a failure, never a TypeError.
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type EntryType,
  type Fetch,
  type Questions,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import { CHECK_NAMES, type CheckName, type Ts013Config } from './config';
import { containsRawIdentifier } from './redact';

export type ErrorCode =
  | 'DISABLED'
  | 'BREAKER_OPEN'
  | 'AUTH_PAUSED'
  | 'INVALID_PAUSED'
  | 'TIMEOUT'
  | 'CONNECTION'
  | 'RATE_LIMIT'
  | 'OVERLOADED'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'BAD_RESPONSE'
  | 'PII_BLOCKED'
  | 'STATE_TOO_LARGE'
  | 'UNKNOWN';

export type CallResult<Q extends Questions> =
  | {
      ok: true;
      result: SystemOneResult<Q>;
      latencyMs: number;
      /** true when TypeSafe answered with a model other than the pinned one. */
      modelMismatch: boolean;
      /** TypeSafe's x-typesafe-request-id, for tracing a decision with them. */
      requestId?: string;
    }
  | { ok: false; errorCode: ErrorCode; latencyMs: number; message: string };

/**
 * What the gateway calls on behalf of: one of the safety checks, the
 * model-tier router (`route`, lib/ai/router.ts), or the approved-answers
 * selection (`kb_select`, checks/kb-select.ts). Those two are not safety
 * checks — no account switch, policy or decision-log row — so they are
 * not `CheckName`s; each gets its own outage breaker and content-failure
 * keys here, so its traffic can never open a check's breaker or pause a
 * check for an account.
 */
export type SelectionCaller = 'route' | 'kb_select';
export type GatewayCheck = CheckName | SelectionCaller;
export const GATEWAY_CHECKS: readonly GatewayCheck[] = [
  ...CHECK_NAMES,
  'route',
  'kb_select',
];
const isSelectionCaller = (c: GatewayCheck): c is SelectionCaller =>
  c === 'route' || c === 'kb_select';

export interface AlertSink {
  (event: {
    level: 'warn' | 'error';
    code: string;
    check?: GatewayCheck;
    message: string;
  }): void;
}

/** Rolling-window circuit breaker. Successes do not clear the window. */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  constructor(
    private readonly opts: {
      failureThreshold: number;
      windowMs: number;
      cooldownMs: number;
    },
    private readonly now: () => number = Date.now
  ) {}

  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  /** Returns true if this failure opened the breaker. */
  recordFailure(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.opts.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.opts.failureThreshold) {
      this.openUntil = t + this.opts.cooldownMs;
      this.failures = [];
      return true;
    }
    return false;
  }
}

export interface GatewayDeps {
  config: Ts013Config;
  alert?: AlertSink;
  /** Injected for tests; production uses global fetch. */
  fetch?: Fetch;
  apiKey?: string;
  now?: () => number;
  /** Pause after 401/403 before re-probing. Default 5 min. */
  authCooldownMs?: number;
  /** Pause for one check and account after 3 consecutive 422s. Default 15 min. */
  invalidCooldownMs?: number;
}

/** The only endpoint the layer talks to. Pinned, so TYPESAFE_BASE_URL in the
 *  environment cannot redirect the API key and customer state elsewhere. */
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

const MAX_RETRY_AFTER_MS = 500;
const BACKOFF_MAX_MS = 400;
/** Longest a 429's Retry-After may pause every check. */
const MAX_RATE_LIMIT_PAUSE_MS = 60_000;
/**
 * Request budget in characters of JSON. The documented limit is 32k tokens
 * for state plus the longest question and 64k per request; at ~2.5 chars
 * per token for Arabic this stays well inside both.
 */
export const MAX_REQUEST_CHARS = 60_000;

type Outage = 'TIMEOUT' | 'CONNECTION' | 'SERVER' | 'OVERLOADED' | 'UNKNOWN';
const OUTAGE: ReadonlySet<ErrorCode> = new Set<Outage>([
  'TIMEOUT',
  'CONNECTION',
  'SERVER',
  'OVERLOADED',
  'UNKNOWN',
]);

/** Every string leaf of a JSON-like value (keys included). */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringLeaves(v, out);
    }
  return out;
}

export class TypeSafeGateway {
  /** Built on first use: the SDK throws without an API key, and a fully disabled layer never needs one. */
  private clientInstance: TypeSafeClient | null = null;
  /** Outage breakers, per check (and one each for route and kb_select). */
  private readonly breakers: Record<GatewayCheck, CircuitBreaker>;
  /** Content-class breakers and 422 pauses, per `${check}:${accountId}`. */
  private readonly contentBreakers = new Map<string, CircuitBreaker>();
  private readonly invalidStreak = new Map<string, number>();
  private readonly invalidUntil = new Map<string, number>();
  private authUntil = 0;
  private rateLimitedUntil = 0;
  private readonly alert: AlertSink;
  private readonly now: () => number;

  constructor(private readonly deps: GatewayDeps) {
    const { config } = deps;
    this.now = deps.now ?? Date.now;
    this.alert = deps.alert ?? (() => {});
    this.breakers = Object.fromEntries(
      GATEWAY_CHECKS.map((c) => [
        c,
        new CircuitBreaker(config.breaker, this.now),
      ])
    ) as Record<GatewayCheck, CircuitBreaker>;
  }

  /** An API key is configured (passed in, or TYPESAFE_API_KEY). */
  hasKey(): boolean {
    return !!(this.deps.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim());
  }

  private get client(): TypeSafeClient {
    const { config } = this.deps;
    this.clientInstance ??= new TypeSafeClient({
      apiKey: this.deps.apiKey,
      baseURL: TYPESAFE_BASE_URL,
      defaultModel: config.model,
      timeout: config.timeoutMs,
      retry: {
        maxRetries: config.maxRetries,
        backoffInitialMs: 200,
        backoffMaxMs: BACKOFF_MAX_MS,
        maxRetryAfterMs: MAX_RETRY_AFTER_MS, // never wait long on the send path
        // No 429: an immediate retry ignores the server's Retry-After on a
        // key every tenant shares. The gateway's cool-down handles it.
        httpStatuses: new Set([
          408,
          ...Array.from({ length: 100 }, (_, i) => 500 + i),
        ]),
      },
      // "debug" would log request bodies (customer text) unredacted by the SDK. Never raise above warn.
      logLevel: 'warn',
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    return this.clientInstance;
  }

  private contentBreaker(key: string): CircuitBreaker {
    let b = this.contentBreakers.get(key);
    if (!b) {
      b = new CircuitBreaker(this.deps.config.breaker, this.now);
      this.contentBreakers.set(key, b);
    }
    return b;
  }

  /** Why a call would be refused right now, or null when it may go out. */
  private pausedFor(
    check: GatewayCheck,
    key: string
  ): { errorCode: ErrorCode; message: string } | null {
    const t = this.now();
    // The router and the approved-answers selection have no TS_ENABLED_*
    // switch: they run wherever a key is set.
    if (
      isSelectionCaller(check)
        ? !this.hasKey()
        : !this.deps.config.enabled[check]
    )
      return { errorCode: 'DISABLED', message: `${check} disabled` };
    if (t < this.authUntil)
      return { errorCode: 'AUTH_PAUSED', message: 'paused after auth failure' };
    if (t < this.rateLimitedUntil)
      return { errorCode: 'RATE_LIMIT', message: 'waiting out Retry-After' };
    if (t < (this.invalidUntil.get(key) ?? 0))
      return {
        errorCode: 'INVALID_PAUSED',
        message: 'paused after repeated 422',
      };
    if (this.breakers[check].isOpen() || this.contentBreaker(key).isOpen())
      return { errorCode: 'BREAKER_OPEN', message: 'circuit breaker open' };
    return null;
  }

  /** True when the check may call TypeSafe right now (for this account). */
  available(check: GatewayCheck, accountId = '*'): boolean {
    return this.pausedFor(check, `${check}:${accountId}`) === null;
  }

  async ask<const Q extends Questions>(
    check: GatewayCheck,
    /** Already-redacted state. Plain JSON only. */
    state: string | object,
    questions: Q,
    /** The tenant, for content-class failure accounting. */
    accountId = '*',
    /** `deadlineMs` caps the whole call, retries included, below the
     *  check's usual budget (the router's short hard deadline). */
    opts: { deadlineMs?: number } = {}
  ): Promise<CallResult<Q>> {
    const started = this.now();
    const elapsed = () => this.now() - started;
    const { config } = this.deps;
    const key = `${check}:${accountId}`;

    const paused = this.pausedFor(check, key);
    if (paused) return { ok: false, ...paused, latencyMs: 0 };

    // Last line of defence: refuse to send if an identifier-shaped value
    // survived redaction. Each string is checked exactly as redaction saw
    // it — scanning the JSON text instead would read escapes ("\n@a.co")
    // that redaction never saw, and hand the customer a switch that
    // withholds the request.
    if (stringLeaves({ state, questions }).some(containsRawIdentifier)) {
      this.alert({
        level: 'error',
        code: 'TS_PII_BLOCKED',
        check,
        message:
          'Request withheld: identifier-shaped value found after redaction.',
      });
      return {
        ok: false,
        errorCode: 'PII_BLOCKED',
        latencyMs: 0,
        message: 'PII guard',
      };
    }
    const size = JSON.stringify({ state, questions }).length;
    if (size > MAX_REQUEST_CHARS) {
      this.alert({
        level: 'warn',
        code: 'TS_STATE_TOO_LARGE',
        check,
        message: `Request withheld: ${size} chars exceeds the ${MAX_REQUEST_CHARS} budget.`,
      });
      return {
        ok: false,
        errorCode: 'STATE_TOO_LARGE',
        latencyMs: 0,
        message: 'state too large',
      };
    }

    const budget = opts.deadlineMs ?? Infinity;
    const timeout = Math.min(
      check === 'guardrail' ? config.guardrailTimeoutMs : config.timeoutMs,
      budget
    );
    const deadlineMs = Math.min(
      timeout * (config.maxRetries + 1) +
        config.maxRetries * (BACKOFF_MAX_MS + MAX_RETRY_AFTER_MS) +
        100,
      budget
    );
    const deadline = AbortSignal.timeout(deadlineMs);

    try {
      const { data: result, requestId } = await this.client
        .systemOne(
          { state: state as EntryType, questions, model: config.model },
          { timeout, signal: deadline }
        )
        .withResponse();
      const shapeError = validateAnswers(questions, result);
      if (shapeError) {
        this.fail(check, key, 'BAD_RESPONSE');
        this.alert({
          level: 'error',
          code: 'TS_BAD_RESPONSE',
          check,
          message: `${shapeError}${requestId ? ` (request ${requestId})` : ''}`,
        });
        return {
          ok: false,
          errorCode: 'BAD_RESPONSE',
          latencyMs: elapsed(),
          message: shapeError,
        };
      }
      this.invalidStreak.delete(key);
      const modelMismatch = result.model !== config.model;
      if (modelMismatch) {
        this.alert({
          level: 'warn',
          code: 'MODEL_MISMATCH',
          check,
          message: `TypeSafe answered with ${result.model}; pinned ${config.model}.`,
        });
      }
      return {
        ok: true,
        result,
        latencyMs: elapsed(),
        modelMismatch,
        requestId,
      };
    } catch (err) {
      const errorCode =
        err instanceof APIUserAbortError && deadline.aborted
          ? 'TIMEOUT'
          : classify(err);
      const message = safeMessage(err);

      if (errorCode === 'AUTH') {
        this.authUntil = this.now() + (this.deps.authCooldownMs ?? 5 * 60_000);
        this.alert({
          level: 'error',
          code: 'TS_AUTH',
          check,
          message: `TypeSafe rejected the API key; all checks paused. ${message}`,
        });
      } else if (errorCode === 'RATE_LIMIT') {
        const wait =
          err instanceof RateLimitError && err.retryAfterMs
            ? err.retryAfterMs
            : 1000;
        this.rateLimitedUntil =
          this.now() + Math.min(Math.max(wait, 250), MAX_RATE_LIMIT_PAUSE_MS);
        this.alert({
          level: 'warn',
          code: 'TS_RATE_LIMIT',
          check,
          message: `Rate limited; every check waits ${Math.round((this.rateLimitedUntil - this.now()) / 1000)} s. ${message}`,
        });
      } else if (errorCode === 'INVALID_REQUEST') {
        const streak = (this.invalidStreak.get(key) ?? 0) + 1;
        this.invalidStreak.set(key, streak);
        if (streak >= 3) {
          this.invalidUntil.set(
            key,
            this.now() + (this.deps.invalidCooldownMs ?? 15 * 60_000)
          );
          this.invalidStreak.delete(key);
          this.alert({
            level: 'error',
            code: 'TS_422',
            check,
            message: `3 consecutive 422s; ${check} paused for this account. ${message}`,
          });
        } else {
          this.alert({ level: 'warn', code: 'TS_422', check, message });
        }
      } else {
        this.fail(check, key, errorCode);
      }
      return { ok: false, errorCode, latencyMs: elapsed(), message };
    }
  }

  private fail(check: GatewayCheck, key: string, code: ErrorCode): void {
    const breaker = OUTAGE.has(code)
      ? this.breakers[check]
      : this.contentBreaker(key);
    if (breaker.recordFailure()) {
      this.alert({
        level: 'warn',
        code: 'TS_BREAKER_OPEN',
        check,
        message: `Circuit opened after repeated failures (${code})${OUTAGE.has(code) ? '' : ' for one account'}.`,
      });
    }
  }
}

export function classify(err: unknown): ErrorCode {
  if (err instanceof APITimeoutError) return 'TIMEOUT';
  if (err instanceof APIConnectionError) return 'CONNECTION';
  if (
    err instanceof AuthenticationError ||
    err instanceof PermissionDeniedError
  )
    return 'AUTH';
  if (err instanceof UnprocessableEntityError) return 'INVALID_REQUEST';
  if (err instanceof RateLimitError) return 'RATE_LIMIT';
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) return 'AUTH';
    if (err.status === 422) return 'INVALID_REQUEST';
    if (err.status === 400) return 'BAD_REQUEST';
    if (err.status === 429) return 'RATE_LIMIT';
    if (err.status === 529) return 'OVERLOADED';
    if (err.status >= 500) return 'SERVER';
  }
  return 'UNKNOWN';
}

/** Error text for alerts: status and request id only — never the response body (it may echo state). */
function safeMessage(err: unknown): string {
  if (err instanceof APIError)
    return `HTTP ${err.status}${err.requestId ? ` (request ${err.requestId})` : ''}`;
  if (err instanceof Error) return `${err.name}`;
  return 'unknown error';
}

/** Checks every question has a well-formed answer of the right type. Returns an error string or null. */
export function validateAnswers(
  questions: Questions,
  result: unknown
): string | null {
  const r = result as {
    model?: unknown;
    answers?: Record<string, Record<string, unknown>>;
    usage?: { input_tokens?: unknown };
  };
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.model !== 'string' ||
    !r.answers ||
    typeof r.answers !== 'object'
  )
    return 'response missing model/answers';
  const finite01 = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  for (const [id, q] of Object.entries(questions)) {
    const a = r.answers[id];
    if (!a || a.type !== q.type) return `answer ${id} missing or wrong type`;
    if (q.type === 'noul' && !finite01(a.noul)) return `answer ${id}: bad noul`;
    if (q.type === 'choice') {
      if (
        typeof a.choice !== 'string' ||
        !Object.prototype.hasOwnProperty.call(q.criteria, a.choice)
      )
        return `answer ${id}: choice not in options`;
      if (!finite01(a.confidence)) return `answer ${id}: bad confidence`;
    }
    if (q.type === 'score') {
      if (
        typeof a.score !== 'number' ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > q.criteria.length - 1
      )
        return `answer ${id}: bad score`;
      if (!finite01(a.confidence)) return `answer ${id}: bad confidence`;
    }
  }
  if (typeof r.usage?.input_tokens !== 'number')
    return 'response missing usage';
  return null;
}
