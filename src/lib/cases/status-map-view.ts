// ============================================================
// The Settings -> Cases "Compass status mapping" card's view logic
// (migration 151): parsing the /api/cases/status-map answers, ordering
// the rows, the Jev chip and merging suggestions that arrive after the
// table. Pure and client-safe: no server module may be imported here.
// ============================================================

import { configErrorText } from './settings-ui';

export type MapSource = 'admin' | 'suggestion';

export interface MappedRow {
  status_key: string;
  status_label: string;
  stage: string;
  source: MapSource;
  suggested_p: number | null;
  open_cases: number;
  /**
   * Open cases holding the status that it moves nowhere (their bank list
   * has neither the mapped stage nor one of that name). null: not known
   * yet (just saved, until the next read).
   */
  unresolved_open_cases: number | null;
}

export interface UnmappedRow {
  status_key: string;
  sample_label: string;
  open_cases: number;
}

export interface StageSuggestion {
  /** null: Jev says the status names no stage. */
  stage: string | null;
  p: number;
}

export interface StatusMapView {
  stages: string[];
  mapped: MappedRow[];
  unmapped: UnmappedRow[];
  available: boolean;
}

export type SavedMapping = Omit<
  MappedRow,
  'open_cases' | 'unresolved_open_cases'
>;

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const prob = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
const source = (v: unknown): MapSource =>
  v === 'suggestion' ? 'suggestion' : 'admin';

export const unmappedLabel = (r: UnmappedRow) => r.sample_label || r.status_key;
export const mappedLabel = (r: MappedRow) => r.status_label || r.status_key;

/** Most open cases first, then by label. */
export function sortUnmapped(rows: UnmappedRow[]): UnmappedRow[] {
  return [...rows].sort(
    (a, b) =>
      b.open_cases - a.open_cases ||
      unmappedLabel(a).localeCompare(unmappedLabel(b))
  );
}

/** Alphabetical by label. */
export function sortMapped(rows: MappedRow[]): MappedRow[] {
  return [...rows].sort((a, b) => mappedLabel(a).localeCompare(mappedLabel(b)));
}

/** A GET answer as the card's view, or null when it is not one. */
export function parseStatusMap(body: unknown): StatusMapView | null {
  const b = obj(body);
  if (
    !b ||
    !Array.isArray(b.stages) ||
    !Array.isArray(b.mapped) ||
    !Array.isArray(b.unmapped)
  )
    return null;
  const mapped: MappedRow[] = [];
  for (const raw of b.mapped) {
    const r = obj(raw);
    if (!r || !str(r.status_key)) continue;
    mapped.push({
      status_key: str(r.status_key),
      status_label: str(r.status_label),
      stage: str(r.stage),
      source: source(r.source),
      suggested_p: prob(r.suggested_p),
      open_cases: count(r.open_cases),
      unresolved_open_cases:
        typeof r.unresolved_open_cases === 'number'
          ? count(r.unresolved_open_cases)
          : null,
    });
  }
  const unmapped: UnmappedRow[] = [];
  for (const raw of b.unmapped) {
    const r = obj(raw);
    if (!r || !str(r.status_key)) continue;
    unmapped.push({
      status_key: str(r.status_key),
      sample_label: str(r.sample_label),
      open_cases: count(r.open_cases),
    });
  }
  return {
    stages: b.stages.filter((s): s is string => typeof s === 'string' && !!s),
    mapped: sortMapped(mapped),
    unmapped: sortUnmapped(unmapped),
    available: b.available === true,
  };
}

/**
 * The usable suggestions of a GET answer: a probability from 0 to 1 and
 * a stage that is null (no stage) or one of `stages`. Anything else is
 * left out, so a stale or malformed suggestion shows no chip.
 */
export function parseSuggestions(
  body: unknown,
  stages: string[]
): Record<string, StageSuggestion> {
  const raw = obj(obj(body)?.suggestions);
  const out: Record<string, StageSuggestion> = {};
  if (!raw) return out;
  const allowed = new Set(stages);
  for (const [key, value] of Object.entries(raw)) {
    const s = obj(value);
    const p = prob(s?.p);
    if (!s || p === null) continue;
    if (s.stage === null) out[key] = { stage: null, p };
    else if (typeof s.stage === 'string' && allowed.has(s.stage))
      out[key] = { stage: s.stage, p };
  }
  return out;
}

/** Suggestions that arrived later win over older ones for the same key. */
export function mergeSuggestions(
  prev: Record<string, StageSuggestion>,
  next: Record<string, StageSuggestion>
): Record<string, StageSuggestion> {
  return { ...prev, ...next };
}

/** A probability as a whole percentage, 0-100. */
export function percent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, Math.round(p * 100)));
}

/** What a Jev chip says; the card turns it into words. */
export type Chip =
  { kind: 'stage'; stage: string; pct: number } | { kind: 'none'; pct: number };

export function chipFor(s: StageSuggestion): Chip {
  return s.stage === null
    ? { kind: 'none', pct: percent(s.p) }
    : { kind: 'stage', stage: s.stage, pct: percent(s.p) };
}

/**
 * The view after a save: the status leaves Unmapped and joins Mapped
 * (replacing an older mapping of the same key) with its open-case count.
 * Its unresolved count is unknown (null) until the next read: only the
 * server knows which banks lack the stage.
 */
export function withSaved(
  view: StatusMapView,
  saved: SavedMapping
): StatusMapView {
  const from = view.unmapped.find((u) => u.status_key === saved.status_key);
  const old = view.mapped.find((m) => m.status_key === saved.status_key);
  const row: MappedRow = {
    ...saved,
    open_cases: from?.open_cases ?? old?.open_cases ?? 0,
    unresolved_open_cases: null,
  };
  return {
    ...view,
    unmapped: view.unmapped.filter((u) => u.status_key !== saved.status_key),
    mapped: sortMapped([
      ...view.mapped.filter((m) => m.status_key !== saved.status_key),
      row,
    ]),
  };
}

/** A PUT answer's `mapping`, or null. */
export function parseMapping(body: unknown): SavedMapping | null {
  const r = obj(obj(body)?.mapping);
  if (!r || !str(r.status_key) || !str(r.stage)) return null;
  return {
    status_key: str(r.status_key),
    status_label: str(r.status_label),
    stage: str(r.stage),
    source: source(r.source),
    suggested_p: prob(r.suggested_p),
  };
}

/** An apply answer's counts, or null. */
export function parseApplied(
  body: unknown
): { moved: number; unchanged: number } | null {
  const r = obj(body);
  if (!r || typeof r.moved !== 'number') return null;
  return { moved: count(r.moved), unchanged: count(r.unchanged) };
}

export type StatusMapErrorKey =
  'statusFinal' | 'stageNotAllowed' | 'stageNotConfigured' | 'notAllowed';

const ERROR_KEYS: Record<string, StatusMapErrorKey> = {
  STATUS_FINAL: 'statusFinal',
  STAGE_NOT_ALLOWED: 'stageNotAllowed',
  STAGE_NOT_CONFIGURED: 'stageNotConfigured',
  NOT_ALLOWED: 'notAllowed',
};

/** The card's own wording for a refusal, else the server's `error` text. */
export function statusMapError(
  body: unknown,
  status: number
): { key: StatusMapErrorKey } | { text: string } {
  const key = ERROR_KEYS[str(obj(body)?.code)];
  return key ? { key } : { text: configErrorText(body, status) };
}
