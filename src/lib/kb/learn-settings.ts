/**
 * Learn from team answers (migration 290): the switch's shape, shared by
 * the settings route and the switch in Settings → AI. Dependency-free
 * on purpose: a client import graph that reaches a server module breaks
 * the production build.
 */

/** 290's column default: off until an owner or admin switches it on. */
export const KB_LEARN_SETTINGS_OFF: KbLearnSettings = Object.freeze({
  enabled: false,
  lastRunAt: null,
  lastRunDrafted: null,
  lastRunError: null,
  nextRunAt: null,
  available: true,
}) as KbLearnSettings;

/** Why the last run did not finish (290's CHECK on last_run_error, with
 *  'running' beside them while a run works). */
export const KB_LEARN_RUN_ERRORS = [
  'no_ai',
  'read_failed',
  'out_of_time',
  'model',
  'failed',
] as const;
export type KbLearnRunError = (typeof KB_LEARN_RUN_ERRORS)[number];

/** GET / PUT /api/ai/kb/learn */
export interface KbLearnSettings {
  enabled: boolean;
  /** When the weekly run last started; null before the first. */
  lastRunAt: string | null;
  /** Drafts the last run wrote; null while it runs or before the first. */
  lastRunDrafted: number | null;
  /** 'running' from the claim until the run ends, then why it failed;
   *  null when it finished. */
  lastRunError: 'running' | KbLearnRunError | null;
  /** When it runs, or tries, again; null before the first. */
  nextRunAt: string | null;
  /** False when migration 290 is not applied yet. */
  available: boolean;
}

/** A code this build does not know still says that the run failed. */
function runErrorFrom(value: unknown): KbLearnSettings['lastRunError'] {
  if (typeof value !== 'string' || value === '') return null;
  if (value === 'running') return value;
  return KB_LEARN_RUN_ERRORS.find((code) => code === value) ?? 'failed';
}

/** A kb_learn_settings row (or the RPC's answer, or none) as settings. */
export function kbLearnSettingsFrom(
  row:
    | {
        enabled?: unknown;
        last_run_at?: unknown;
        last_run_drafted?: unknown;
        last_run_error?: unknown;
        next_run_at?: unknown;
      }
    | null
    | undefined
): KbLearnSettings {
  if (!row) return KB_LEARN_SETTINGS_OFF;
  const drafted = row.last_run_drafted;
  return {
    enabled: row.enabled === true,
    lastRunAt: typeof row.last_run_at === 'string' ? row.last_run_at : null,
    lastRunDrafted:
      typeof drafted === 'number' && Number.isInteger(drafted) && drafted >= 0
        ? drafted
        : null,
    lastRunError: runErrorFrom(row.last_run_error),
    nextRunAt: typeof row.next_run_at === 'string' ? row.next_run_at : null,
    available: true,
  };
}

/** The PUT body: `{ enabled: boolean }`, nothing else read. */
export function parseKbLearnPut(
  body: unknown
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'Expected an object' };
  const enabled = (body as Record<string, unknown>).enabled;
  if (typeof enabled !== 'boolean')
    return { ok: false, error: 'enabled must be true or false' };
  return { ok: true, enabled };
}

/** A learned draft (kb_entries.source, 290's kb_learn_record_draft). */
export function isLearnedEntry(entry: { source: string | null }): boolean {
  return entry.source === 'learned';
}

/** `GET`/`PUT /api/ai/kb/learn`'s answer, or null when it is not one: the
 *  switch must not show "off" for an answer it could not read. */
export function parseKbLearnResponse(json: unknown): KbLearnSettings | null {
  if (!json || typeof json !== 'object') return null;
  const v = json as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') return null;
  return {
    ...kbLearnSettingsFrom({
      enabled: v.enabled,
      last_run_at: v.lastRunAt,
      last_run_drafted: v.lastRunDrafted,
      last_run_error: v.lastRunError,
      next_run_at: v.nextRunAt,
    }),
    available: v.available !== false,
  };
}

// ------------------------------------------------------------------
// The switch's decisions (the component only draws them).
// ------------------------------------------------------------------

/** `settings` is null until they were read; `saving` is what is being
 *  saved, `settings` staying as stored until the server answers. */
export interface KbLearnSwitchState {
  settings: KbLearnSettings | null;
  loadFailed: boolean;
  saving: boolean | null;
}

export const KB_LEARN_SWITCH_LOADING: KbLearnSwitchState = Object.freeze({
  settings: null,
  loadFailed: false,
  saving: null,
}) as KbLearnSwitchState;

export type KbLearnSwitchEvent =
  | { type: 'load' }
  | { type: 'loaded'; ok: boolean; json: unknown }
  | { type: 'save'; enabled: boolean }
  | { type: 'saved'; ok: boolean; json: unknown };

export function kbLearnSwitchReduce(
  state: KbLearnSwitchState,
  event: KbLearnSwitchEvent
): KbLearnSwitchState {
  switch (event.type) {
    case 'load':
      return KB_LEARN_SWITCH_LOADING;
    case 'loaded': {
      const settings = event.ok ? parseKbLearnResponse(event.json) : null;
      return { settings, loadFailed: settings === null, saving: null };
    }
    case 'save':
      // Never over a setting that was not read.
      return canToggle(state) ? { ...state, saving: event.enabled } : state;
    case 'saved':
      if (state.saving === null || !state.settings) return state;
      // Refused: back to what is stored.
      if (!event.ok) return { ...state, saving: null };
      return {
        ...state,
        settings: parseKbLearnResponse(event.json) ?? {
          ...state.settings,
          enabled: state.saving,
        },
        saving: null,
      };
  }
}

const canToggle = (state: KbLearnSwitchState) =>
  state.settings !== null && state.settings.available && state.saving === null;

/** A pass works for under a minute, plus its last model call: one
 *  'running' longer than this died. */
export const KB_LEARN_RUN_STALE_MS = 10 * 60_000;

/** What a run failure is called (keys of the KbLearn catalogue). */
const FAILURE_KEYS = {
  no_ai: 'failedNoAi',
  read_failed: 'failedRead',
  out_of_time: 'failedTime',
  model: 'failedModel',
  failed: 'failedOther',
} as const satisfies Record<KbLearnRunError, string>;

export type KbLearnLine =
  | { key: 'notApplied' | 'notRunYet' | 'runningNow' }
  | { key: 'lastRun'; at: string }
  | { key: 'lastRunDrafts'; at: string; count: number }
  | {
      key: (typeof FAILURE_KEYS)[KbLearnRunError] | 'failedStopped';
      /** When it tries again; null = within the hour. */
      retryAt: string | null;
    };

export type KbLearnSwitchView =
  | { kind: 'loading' }
  /** "Could not load" with Retry, and no switch. */
  | { kind: 'failed' }
  | {
      kind: 'switch';
      checked: boolean;
      disabled: boolean;
      line: KbLearnLine | null;
    };

export function kbLearnSwitchView(
  state: KbLearnSwitchState,
  now: number
): KbLearnSwitchView {
  if (state.loadFailed) return { kind: 'failed' };
  const { settings } = state;
  if (!settings) return { kind: 'loading' };
  return {
    kind: 'switch',
    checked: state.saving ?? settings.enabled,
    disabled: !canToggle(state),
    line: lineFor(settings, now),
  };
}

function lineFor(s: KbLearnSettings, now: number): KbLearnLine | null {
  if (!s.available) return { key: 'notApplied' };
  if (!s.enabled) return null;
  if (s.lastRunError) {
    // Checked hourly: a time that is over means the next check.
    const retryAt =
      s.nextRunAt && Date.parse(s.nextRunAt) > now ? s.nextRunAt : null;
    if (s.lastRunError !== 'running')
      return { key: FAILURE_KEYS[s.lastRunError], retryAt };
    const started = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
    return now - started <= KB_LEARN_RUN_STALE_MS
      ? { key: 'runningNow' }
      : { key: 'failedStopped', retryAt };
  }
  if (!s.lastRunAt) return { key: 'notRunYet' };
  return s.lastRunDrafted === null
    ? { key: 'lastRun', at: s.lastRunAt }
    : { key: 'lastRunDrafts', at: s.lastRunAt, count: s.lastRunDrafted };
}
