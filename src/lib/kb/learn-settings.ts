/**
 * Learn from team answers (migration 278): the switch's shape, shared by
 * the settings route and the switch in Settings → AI. Dependency-free
 * on purpose: a client import graph that reaches a server module breaks
 * the production build.
 */

/** 278's column default: off until an owner or admin switches it on. */
export const KB_LEARN_SETTINGS_OFF: KbLearnSettings = Object.freeze({
  enabled: false,
  lastRunAt: null,
  available: true,
}) as KbLearnSettings;

/** GET / PUT /api/ai/kb/learn */
export interface KbLearnSettings {
  enabled: boolean;
  /** When the weekly run last started; null before the first. */
  lastRunAt: string | null;
  /** False when migration 278 is not applied yet. */
  available: boolean;
}

/** A kb_learn_settings row (or the RPC's answer, or none) as settings. */
export function kbLearnSettingsFrom(
  row: { enabled?: unknown; last_run_at?: unknown } | null | undefined
): KbLearnSettings {
  if (!row) return KB_LEARN_SETTINGS_OFF;
  return {
    enabled: row.enabled === true,
    lastRunAt: typeof row.last_run_at === 'string' ? row.last_run_at : null,
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

/** A learned draft (kb_entries.source, 278's kb_learn_record_draft). */
export function isLearnedEntry(entry: { source: string | null }): boolean {
  return entry.source === 'learned';
}
