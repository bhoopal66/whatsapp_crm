// ============================================================
// Pure helpers for the case Brain tab (package 022e): parse the summary
// page GET, decide which state to show, and the small label pieces.
// Dependency-free on purpose: the tab is a client component, and the
// other src/lib/brain modules pull the service-role client and
// node:crypto.
// ============================================================

export type BrainCitationView = { kind: string; id: string };

export type BrainPageView = {
  summary: string;
  version: number;
  /** ISO time the page was built, or null when the server has none. */
  builtAt: string | null;
  citations: BrainCitationView[];
};

/**
 * What the tab shows for a page GET. 404 is the normal "no summary yet"
 * (also a page the caller may not read: the route answers the same 404);
 * 403 `brain_disabled` is the workspace switch being off.
 */
export type BrainPageState =
  | { kind: 'page'; page: BrainPageView }
  | { kind: 'none' }
  | { kind: 'off' }
  | { kind: 'error' };

export type BrainRebuildResult = {
  rebuilt: number;
  failed: number;
  remaining: number;
};

const SHORT_ID = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** The 200 body of GET /api/brain/pages/case/<id>, or null if malformed. */
export function parseBrainPage(json: unknown): BrainPageView | null {
  if (!isRecord(json)) return null;
  const { summary, version, builtAt, citations } = json;
  if (typeof summary !== 'string' || !isCount(version)) return null;
  if (builtAt !== null && typeof builtAt !== 'string') return null;
  if (!Array.isArray(citations)) return null;
  const cites: BrainCitationView[] = [];
  for (const c of citations) {
    if (!isRecord(c) || typeof c.kind !== 'string' || typeof c.id !== 'string')
      return null;
    cites.push({ kind: c.kind, id: c.id });
  }
  // The tab already shows the AI-generated label and caution line; drop
  // the summariser's own header so it isn't said twice.
  const body = summary.replace(/^AI-generated summary[^\n]*(\n|$)/, '');
  return { summary: body, version, builtAt, citations: cites };
}

/** Which state a page GET's status and body put the tab in. */
export function brainPageState(status: number, json: unknown): BrainPageState {
  if (status === 404) return { kind: 'none' };
  if (status === 403 && isRecord(json) && json.error === 'brain_disabled')
    return { kind: 'off' };
  if (status !== 200) return { kind: 'error' };
  const page = parseBrainPage(json);
  return page ? { kind: 'page', page } : { kind: 'error' };
}

/** The 200 body of POST /api/brain/pages/rebuild, or null if malformed. */
export function parseRebuildResult(json: unknown): BrainRebuildResult | null {
  if (!isRecord(json)) return null;
  const { rebuilt, failed, remaining } = json;
  if (!isCount(rebuilt) || !isCount(failed) || !isCount(remaining)) return null;
  return { rebuilt, failed, remaining };
}

/** A citation's id as shown: its first 8 characters. */
export function shortCitationId(id: string): string {
  return id.slice(0, SHORT_ID);
}

export type BuiltAgo =
  { unit: 'now' } | { unit: 'minute' | 'hour' | 'day'; value: number };

/**
 * How long ago a page was built, for Intl.RelativeTimeFormat: under a
 * minute (or a clock a little ahead of ours) is "now"; null when there is
 * no usable time.
 */
export function builtAgo(builtAt: string | null, now: number): BuiltAgo | null {
  if (!builtAt) return null;
  const at = Date.parse(builtAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', value: hours };
  return { unit: 'day', value: Math.floor(hours / 24) };
}
