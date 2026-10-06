/**
 * The contract between the Settings → AI safety checks panel and its API
 * routes (`/api/typesafe/settings`, `/api/typesafe/activity`).
 *
 * Types only, and no imports: the panel is a client component, and this
 * file must never pull server code (the SDK, node:crypto) into a browser
 * bundle.
 */

/** Monitor only: decisions are logged, never acted on. Live: they act. */
export type TsMode = 'monitor' | 'live';

/** English only keeps other languages logged-only until calibrated. */
export type TsLanguages = 'english' | 'all';

export type TsCheck = 'triage' | 'guardrail' | 'passages';

/** One account's switches (table ts_account_settings, migration 064). */
export interface TsAccountSettings {
  /** Master switch for the account. Off: nothing is sent to TypeSafe. */
  enabled: boolean;
  mode: TsMode;
  /** Hand off requests for a person, complaints and opt-outs. */
  triage: boolean;
  /** Screen the bot's replies before they are sent. */
  guardrail: boolean;
  /** Filter knowledge-base excerpts before the bot answers. */
  passages: boolean;
  /** Also watch conversations people handle: detect opt-outs there. */
  watchHumanThreads: boolean;
  languages: TsLanguages;
  updatedAt: string | null;
  /** Display name of whoever saved last. */
  updatedBy: string | null;
}

/** What the server can offer, independent of the account's switches. */
export interface TsStatus {
  /** API key and hash key are set on the server. */
  configured: boolean;
  /** Why the layer is unavailable, when it is (e.g. an invalid setting). */
  problem: string | null;
  model: string;
  /** What the guardrail does with a reply when TypeSafe is unreachable. */
  failMode: 'hold' | 'send';
  /** Checks the server forces to monitor-only for every account
   *  (TS_SHADOW, or TS_SHADOW_<CHECK>): logged, never acted on. */
  forcedMonitor: Record<TsCheck, boolean>;
  /** Checks the server allows (a TS_ENABLED_<CHECK>=false turns one off). */
  checksAvailable: Record<TsCheck, boolean>;
  /** This account may use the layer (TS_ACCOUNT_IDS, when set). */
  accountAllowed: boolean;
  /** Custom thresholds in effect per check; null = the built-in ones
   *  (none approved, or one approved for another model or question set,
   *  which the layer ignores). */
  policies: Record<TsCheck, TsPolicyInfo | null>;
}

export interface TsPolicyInfo {
  version: number;
  /** Approved as logged-only (ts_policy.shadow): this check never acts,
   *  even in Live. */
  loggedOnly: boolean;
}

export interface TsSettingsResponse {
  settings: TsAccountSettings;
  status: TsStatus;
}

/** The writable switches. */
export type TsSettingsUpdate = Pick<
  TsAccountSettings,
  | 'enabled'
  | 'mode'
  | 'triage'
  | 'guardrail'
  | 'passages'
  | 'watchHumanThreads'
  | 'languages'
>;

/**
 * PUT /api/typesafe/settings body: the whole set of switches, plus
 * - `expectedUpdatedAt`: the `updatedAt` this change was made against
 *   (null when the account never saved). If someone saved since, the
 *   PUT is refused with 409 and a `TsSettingsConflict` body.
 * - `confirmLive`: required (true) when the change makes the layer act
 *   where it did not — enabled + Live from anything else — else 409.
 */
export interface TsSettingsPut extends TsSettingsUpdate {
  expectedUpdatedAt: string | null;
  confirmLive?: boolean;
}

/** 409 body: what the server holds now. */
export interface TsSettingsConflict {
  error: string;
  reason: 'changed' | 'confirm_live';
  current: TsSettingsResponse;
}

export interface TsActivityItem {
  id: string;
  createdAt: string;
  check: TsCheck | 'eligibility';
  /**
   * The outcome:
   * - triage: 'bot' | 'bot_restricted' | 'rm' | 'opted_out' | 'host_default';
   * - guardrail: 'send' | 'hold' | 'block';
   * - passages: 'include=N;conflict=N;drop=N' | 'fallback_top_k'.
   */
  decision: string;
  /** Machine reason codes, e.g. HUMAN_REQUEST, OPT_OUT_RECORD, CODE_UNSUPPORTED_FIGURE. */
  reasonCodes: string[];
  /** true = taken in Live and binding (a pass included); false = logged only. */
  acted: boolean;
  /** The decision changed what happened: a hand-off, an opt-out, a
   *  held or blocked reply, excerpts removed or set apart. */
  intervened: boolean;
  /** TypeSafe was unavailable and the fallback applied. */
  fallbackUsed: boolean;
  language: string | null;
  latencyMs: number | null;
  errorCode: string | null;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
}

/** Always the whole window, whatever filters the page uses. */
export interface TsActivitySummary {
  days: number;
  decisions: number;
  /** Decisions that changed what happened (see TsActivityItem.intervened). */
  acted: number;
  /** Threads triage handed to a person (acted). */
  triageHandoffs: number;
  /** Opt-outs recorded (acted). */
  optOuts: number;
  /** Bot replies held for review (acted). */
  repliesHeld: number;
  /** Bot replies blocked (acted). */
  repliesBlocked: number;
  /** Knowledge excerpts the filter removed (acted). */
  passagesDropped: number;
  /** Decisions where TypeSafe was unavailable. */
  fallbacks: number;
  estUsd: number;
  p95LatencyMs: number | null;
  lastDecisionAt: string | null;
}

export interface TsActivityResponse {
  summary: TsActivitySummary;
  items: TsActivityItem[];
  /** Opaque cursor: pass as ?before= for the next page; null when there
   *  is none. */
  nextBefore: string | null;
}
