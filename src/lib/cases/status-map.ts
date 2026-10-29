/**
 * Compass status -> case stage map (migration 151), server side: the four
 * RPCs behind /api/cases/status-map, and Jev's suggestions for statuses
 * nobody has mapped yet.
 *
 * The RPCs are granted to the service role only; each takes the caller's
 * auth user id as `p_actor` and re-checks that they are a live owner /
 * admin of their ACTIVE account (the account comes from the actor, never
 * a parameter). A refusal arrives as a HINT code, which `fail` turns into
 * a CaseRefusedError and `statusMapErrorResponse` into the case routes'
 * `{ error, code }` (422; NOT_ALLOWED is 403).
 *
 * Suggestions are advice for the settings card only: nothing is mapped
 * until an admin saves one (source 'suggestion'). They never throw and
 * are `{}` when Jev is not usable for the account.
 */
import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';

import { getDecisionLayer, type DecisionLayer } from '@/lib/typesafe';
import { mapLimit } from '@/lib/typesafe/checks/common';
import { MAX_KNOWN_MAPPINGS } from '@/lib/typesafe/checks/status-map';
import { accountEnabled } from '@/lib/typesafe/config';
import { STATUS_MAP_QS_VERSION } from '@/lib/typesafe/questions/status-map';

import { configErrorResponse } from './config-http';
import { CaseStoreError, fail } from './store';

export type StatusMapSource = 'admin' | 'suggestion';
export const STATUS_MAP_SOURCES: readonly StatusMapSource[] = [
  'admin',
  'suggestion',
];
/** 151's limits: a status is 1-64 characters, a stage at most 100. */
export const MAX_STATUS_CHARS = 64;
export const MAX_STAGE_CHARS = 100;

export interface MappedStatus {
  status_key: string;
  status_label: string;
  stage: string;
  source: StatusMapSource;
  suggested_p: number | null;
  open_cases: number;
  /** Open cases holding the status that it moves nowhere (their bank list has neither the mapped stage nor one of that name). */
  unresolved_open_cases: number;
}

export interface UnmappedStatus {
  status_key: string;
  sample_label: string;
  open_cases: number;
}

export interface StatusMapOverview {
  /** Allowed targets, the default order first. */
  stages: string[];
  mapped: MappedStatus[];
  unmapped: UnmappedStatus[];
}

export interface StatusMapping {
  status_key: string;
  status_label: string;
  stage: string;
  source: StatusMapSource;
  suggested_p: number | null;
}

export interface Suggestion {
  /** null: Jev says the status names no stage (keep the case where it is). */
  stage: string | null;
  p: number;
  runnerUp: { stage: string | null; p: number } | null;
}

type Layer = Pick<DecisionLayer, 'config' | 'gateway' | 'statusMap'>;

// ---------------------------------------------------------------------------
// RPCs (service-role client, actor = the session's auth user id)
// ---------------------------------------------------------------------------

async function call(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) fail(fn, error);
  return data;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function mapping(v: unknown): StatusMapping {
  const r = obj(v);
  return {
    status_key: str(r.status_key),
    status_label: str(r.status_label),
    stage: str(r.stage),
    source: r.source === 'suggestion' ? 'suggestion' : 'admin',
    suggested_p: numOrNull(r.suggested_p),
  };
}

/** A jsonb object result, or a store failure (500). */
function objectResult(fn: string, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new CaseStoreError(fn, null);
  return raw as Record<string, unknown>;
}

export async function loadStatusMapOverview(
  db: SupabaseClient,
  actor: string
): Promise<StatusMapOverview> {
  const fn = 'case_status_map_overview';
  const r = objectResult(fn, await call(db, fn, { p_actor: actor }));
  return {
    stages: arr(r.stages).filter((s): s is string => typeof s === 'string'),
    mapped: arr(r.mapped).map((v) => {
      const m = obj(v);
      return {
        ...mapping(m),
        open_cases: num(m.open_cases),
        unresolved_open_cases: num(m.unresolved_open_cases),
      };
    }),
    unmapped: arr(r.unmapped).map((v) => {
      const u = obj(v);
      return {
        status_key: str(u.status_key),
        sample_label: str(u.sample_label),
        open_cases: num(u.open_cases),
      };
    }),
  };
}

export async function setStatusMapping(
  db: SupabaseClient,
  actor: string,
  input: {
    status: string;
    stage: string;
    source: StatusMapSource;
    suggestedP: number | null;
  }
): Promise<StatusMapping> {
  const fn = 'case_status_map_set';
  return mapping(
    objectResult(
      fn,
      await call(db, fn, {
        p_actor: actor,
        p_status: input.status,
        p_stage: input.stage,
        p_source: input.source,
        p_suggested_p: input.suggestedP,
      })
    )
  );
}

export async function deleteStatusMapping(
  db: SupabaseClient,
  actor: string,
  status: string
): Promise<boolean> {
  return (
    (await call(db, 'case_status_map_delete', {
      p_actor: actor,
      p_status: status,
    })) === true
  );
}

export async function applyStatusMapping(
  db: SupabaseClient,
  actor: string,
  status: string
): Promise<{ moved: number; unchanged: number }> {
  const fn = 'case_status_map_apply';
  const r = objectResult(
    fn,
    await call(db, fn, { p_actor: actor, p_status: status })
  );
  return { moved: num(r.moved), unchanged: num(r.unchanged) };
}

/** A status-map route's error as a response (HINT refusals -> 422 + code). */
export function statusMapErrorResponse(
  err: unknown,
  route: string
): NextResponse {
  return configErrorResponse(err, `status-map ${route}`);
}

// ---------------------------------------------------------------------------
// Jev suggestions
// ---------------------------------------------------------------------------

/** At most this many unmapped statuses are judged per overview. */
export const MAX_SUGGESTIONS = 30;
const CONCURRENCY = 3;
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 2000;

/**
 * Name-rule examples shown to Jev beside the account's own mappings: a
 * Compass-style code and the default stage it plainly names. Each is
 * sent only when that stage is in the account's list.
 */
const BUILT_IN_EXAMPLES: readonly { status: string; stage: string }[] = [
  { status: 'UNDER_REVIEW', stage: 'Under review' },
  { status: 'DOCUMENTS_REQUESTED', stage: 'Documents requested' },
  { status: 'QUERY_RAISED', stage: 'Query raised' },
  { status: 'BANK_ACKNOWLEDGED', stage: 'Bank acknowledged' },
];

/** 151's case_status_key in TS. */
const keyOf = (status: string) =>
  status.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** The account's mapped rows first, then built-in examples; at most 12. */
export function knownMappingsFor(
  overview: StatusMapOverview
): { status: string; stage: string }[] {
  const out = overview.mapped
    .filter((m) => m.stage && (m.status_label || m.status_key))
    .map((m) => ({ status: m.status_label || m.status_key, stage: m.stage }));
  const seen = new Set(overview.mapped.map((m) => keyOf(m.status_key)));
  const byLower = new Map(overview.stages.map((s) => [s.toLowerCase(), s]));
  for (const ex of BUILT_IN_EXAMPLES) {
    const stage = byLower.get(ex.stage.toLowerCase());
    if (stage && !seen.has(keyOf(ex.status)))
      out.push({ status: ex.status, stage });
  }
  return out.slice(0, MAX_KNOWN_MAPPINGS);
}

const cache = new Map<string, { at: number; value: Suggestion }>();

/** Test hook: forget every cached suggestion. */
export function clearSuggestionCache(): void {
  cache.clear();
}

const jsonHash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Whether Jev can suggest for this account (an allowed account, a key). */
export function suggestionsAvailable(
  accountId: string,
  layer: Layer | null = getDecisionLayer()
): boolean {
  return (
    layer !== null &&
    accountEnabled(layer.config, accountId) &&
    layer.gateway.hasKey()
  );
}

/**
 * A suggestion per unmapped status (the 30 with the most open cases),
 * keyed by status_key. A status Jev could not judge is left out. Cached
 * per (account, status, question set, stage list, known mappings) for an
 * hour, so saving a mapping (a new example for Jev) asks again; failures
 * are not cached, so the next load asks again. Never throws.
 */
export async function suggestStages(
  accountId: string,
  overview: StatusMapOverview,
  deps: { layer?: Layer | null; now?: () => number } = {}
): Promise<Record<string, Suggestion>> {
  try {
    const layer = deps.layer === undefined ? getDecisionLayer() : deps.layer;
    if (!suggestionsAvailable(accountId, layer) || !layer) return {};
    if (overview.stages.length === 0) return {};
    const now = deps.now ?? Date.now;
    const knownMappings = knownMappingsFor(overview);
    const hash = jsonHash([overview.stages, knownMappings]);
    const todo = overview.unmapped
      .filter((u) => u.status_key)
      .sort((a, b) => b.open_cases - a.open_cases)
      .slice(0, MAX_SUGGESTIONS);
    const out: Record<string, Suggestion> = {};
    await mapLimit(todo, CONCURRENCY, async (u) => {
      const key = [accountId, u.status_key, STATUS_MAP_QS_VERSION, hash].join(
        '\u0000'
      );
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_TTL_MS) {
        out[u.status_key] = hit.value;
        return;
      }
      const r = await layer
        .statusMap({
          accountId,
          status: u.sample_label || u.status_key,
          stages: overview.stages,
          knownMappings,
        })
        .catch(() => null);
      if (!r?.ok) return;
      const value: Suggestion = {
        stage: r.stage,
        p: r.p,
        runnerUp: r.runnerUp,
      };
      if (cache.size >= CACHE_MAX) {
        for (const [k, v] of cache)
          if (now() - v.at >= CACHE_TTL_MS) cache.delete(k);
        if (cache.size >= CACHE_MAX) cache.clear();
      }
      cache.set(key, { at: now(), value });
      out[u.status_key] = value;
    });
    return out;
  } catch {
    return {};
  }
}
