// ============================================================
// Meaning triggers (Flow `intent`, automation `intent_match`): does the
// customer's message mean what an admin described?
//
//   * Gated: Jev must be available for the account and its Smart
//     insights `meaningTriggersEnabled` switch on. Otherwise nothing is
//     asked and nothing fires.
//   * One request per inbound: the Flows engine and the automation
//     dispatch both judge the same message. Whichever asks first asks
//     for every active meaning candidate of the account, both engines'
//     (`loadMeaningCandidates`, cached per process for CANDIDATES_TTL_MS),
//     plus its own; p per candidate (key + a hash of its description and
//     examples, so an edit is asked again) is memoised per (account, gateway message
//     id) for MEMO_TTL_MS, so the second engine finds everything judged.
//     A failed or timed-out request is memoised for every candidate it
//     covered (as "no match"), never retried on the same message, so a
//     slow Jev costs one deadline, not one per engine.
//   * At most INTENT_MAX_CANDIDATES per request: flows first, then the
//     most recently updated. The rest match nothing, with a warning at
//     most once per account per hour.
//   * A candidate whose stored config is invalid is skipped.
//   * Never throws; any failure means no trigger fires.
// ============================================================

import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { getDecisionLayer } from '@/lib/typesafe';
import { getInsightSettings, insightsAvailable } from './settings';
import { INTENT_MAX_CANDIDATES } from '@/lib/typesafe/questions/intent-match';
import {
  meaningThreshold,
  validateIntentTriggerConfig,
  type IntentTriggerConfig,
} from './meaning-config';

export interface MeaningTurn {
  from: 'customer' | 'business';
  text: string;
}

export interface MeaningCandidate {
  /** The caller's own key (`flow:<id>`, `automation:<id>`). Stays local:
   *  Jev sees ordinals only. */
  key: string;
  description: string;
  examples?: string[];
  /** P a match needs, from `meaningThreshold(sensitivity)`. */
  threshold: number;
  /** The row's `updated_at`: over the cap, newer candidates go first. */
  updatedAt?: string;
}

/**
 * The candidate a stored trigger config describes, or null when the
 * config is invalid (an API write can store an empty description on an
 * active row): such a trigger is skipped, never sent to Jev.
 */
export function meaningCandidate(
  key: string,
  rawConfig: unknown,
  updatedAt?: string
): MeaningCandidate | null {
  if (validateIntentTriggerConfig(rawConfig).length > 0) return null;
  const cfg = rawConfig as IntentTriggerConfig;
  return {
    key,
    description: cfg.description.trim(),
    examples: Array.isArray(cfg.examples) ? cfg.examples : undefined,
    threshold: meaningThreshold(cfg.sensitivity),
    updatedAt,
  };
}

export const CANDIDATES_TTL_MS = 30_000;

const candidateCache = new Map<
  string,
  { at: number; list: Promise<MeaningCandidate[] | null> }
>();

interface TriggerRow {
  id: string;
  trigger_config: unknown;
  updated_at?: string | null;
  entry_node_id?: string | null;
}

async function queryMeaningCandidates(
  accountId: string
): Promise<MeaningCandidate[] | null> {
  try {
    const db = supabaseAdmin();
    const [flows, automations] = await Promise.all([
      db
        .from('flows')
        .select('id, trigger_config, updated_at, entry_node_id')
        .eq('account_id', accountId)
        .eq('status', 'active')
        .eq('trigger_type', 'intent'),
      db
        .from('automations')
        .select('id, trigger_config, updated_at')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .eq('trigger_type', 'intent_match'),
    ]);
    if (flows.error || automations.error) return null;
    const out: MeaningCandidate[] = [];
    for (const f of (flows.data ?? []) as TriggerRow[]) {
      if (!f.entry_node_id) continue;
      const c = meaningCandidate(
        `flow:${f.id}`,
        f.trigger_config,
        f.updated_at ?? undefined
      );
      if (c) out.push(c);
    }
    for (const a of (automations.data ?? []) as TriggerRow[]) {
      const c = meaningCandidate(
        `automation:${a.id}`,
        a.trigger_config,
        a.updated_at ?? undefined
      );
      if (c) out.push(c);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Every active meaning candidate of the account: intent flows with an
 * entry node and `intent_match` automations, invalid configs skipped.
 * Cached per process for CANDIDATES_TTL_MS; a failed read is not cached
 * and yields []. Never throws.
 */
export async function loadMeaningCandidates(
  accountId: string
): Promise<MeaningCandidate[]> {
  const now = Date.now();
  const hit = candidateCache.get(accountId);
  if (hit && now - hit.at < CANDIDATES_TTL_MS) return (await hit.list) ?? [];
  const list = queryMeaningCandidates(accountId);
  candidateCache.set(accountId, { at: now, list });
  const got = await list;
  if (got === null && candidateCache.get(accountId)?.list === list)
    candidateCache.delete(accountId);
  return got ?? [];
}

/** Flows first, then the most recently updated, then the larger key. */
function rankForCap(cs: MeaningCandidate[]): MeaningCandidate[] {
  const isFlow = (c: MeaningCandidate) => (c.key.startsWith('flow:') ? 1 : 0);
  return [...cs].sort(
    (a, b) =>
      isFlow(b) - isFlow(a) ||
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
      (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
  );
}

const CAP_WARN_INTERVAL_MS = 60 * 60_000;
const capWarnedAt = new Map<string, number>();

function warnOverCap(accountId: string, count: number): void {
  const now = Date.now();
  const last = capWarnedAt.get(accountId);
  if (last !== undefined && now - last < CAP_WARN_INTERVAL_MS) return;
  capWarnedAt.set(accountId, now);
  console.warn(
    `[insights] meaning triggers: account ${accountId} has ${count} active candidates; only ${INTENT_MAX_CANDIDATES} are judged per message (flows first, then the most recently updated)`
  );
}

export interface JudgeMeaningsInput {
  accountId: string;
  /** The inbound's gateway message id. */
  messageKey: string;
  text: string;
  /** The turns before `text`, oldest first, or a loader called only when
   *  a request is actually made. */
  recentTurns: MeaningTurn[] | (() => Promise<MeaningTurn[]>);
  candidates: MeaningCandidate[];
}

export const MEMO_TTL_MS = 60_000;

interface MemoEntry {
  at: number;
  /** p per candidate signature (key + judged text); null when the
   *  request for it failed. */
  p: Map<string, Promise<number | null>>;
}

const memo = new Map<string, MemoEntry>();

/** Test hook. */
export function __resetMeaningMemo(): void {
  memo.clear();
  candidateCache.clear();
  capWarnedAt.clear();
}

/** A candidate's identity for the memo: its key plus a short hash of the
 *  text that is judged, so an edited description is asked again. */
function signature(c: MeaningCandidate): string {
  const h = createHash('sha1')
    .update(JSON.stringify([c.description, c.examples]))
    .digest('hex')
    .slice(0, 12);
  return `${c.key}\u0000${h}`;
}

function entryFor(accountId: string, messageKey: string): MemoEntry {
  const now = Date.now();
  for (const [k, e] of memo) if (now - e.at >= MEMO_TTL_MS) memo.delete(k);
  const id = `${accountId}\u0000${messageKey}`;
  let e = memo.get(id);
  if (!e) {
    e = { at: now, p: new Map() };
    memo.set(id, e);
  }
  return e;
}

async function ask(
  input: JudgeMeaningsInput,
  candidates: MeaningCandidate[]
): Promise<(number | null)[]> {
  const none = candidates.map(() => null);
  try {
    const ts = getDecisionLayer();
    if (!ts) return none;
    const recentTurns =
      typeof input.recentTurns === 'function'
        ? await input.recentTurns()
        : input.recentTurns;
    const res = await ts.intentMatch({
      accountId: input.accountId,
      message: input.text,
      recentTurns,
      candidates: candidates.map((c) => ({
        description: c.description,
        examples: c.examples,
      })),
    });
    if (!res.ok) return none;
    return candidates.map((_, i) => res.p[i] ?? null);
  } catch (err) {
    console.error(
      '[meaning] judgment failed:',
      err instanceof Error ? err.message : String(err)
    );
    return none;
  }
}

/**
 * p for each candidate that cleared its own threshold (keys absent from
 * the map did not match, or were not judged). Never throws.
 */
export async function judgeMeanings(
  input: JudgeMeaningsInput
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    if (input.candidates.length === 0 || !input.text.trim()) return out;
    if (!insightsAvailable(input.accountId)) return out;
    const settings = await getInsightSettings(input.accountId);
    if (!settings.meaningTriggersEnabled) return out;

    // The caller's own candidates (read fresh) win over the cached
    // account-wide set, which makes the request cover the other engine.
    const all = new Map<string, MeaningCandidate>();
    for (const c of await loadMeaningCandidates(input.accountId))
      all.set(c.key, c);
    for (const c of input.candidates) all.set(c.key, c);

    const entry = entryFor(input.accountId, input.messageKey);
    const missing = [...all.values()].filter((c) => !entry.p.has(signature(c)));
    if (missing.length > 0) {
      const ranked = rankForCap(missing);
      const asked = ranked.slice(0, INTENT_MAX_CANDIDATES);
      if (ranked.length > asked.length)
        warnOverCap(input.accountId, ranked.length);
      const pending = ask(input, asked);
      asked.forEach((c, i) =>
        entry.p.set(
          signature(c),
          pending.then((ps) => ps[i] ?? null)
        )
      );
      for (const c of ranked.slice(asked.length))
        entry.p.set(signature(c), Promise.resolve(null));
    }
    for (const c of input.candidates) {
      const p = await entry.p.get(signature(c));
      if (typeof p === 'number' && p >= c.threshold) out.set(c.key, p);
    }
    return out;
  } catch (err) {
    console.error(
      '[meaning] judgeMeanings failed:',
      err instanceof Error ? err.message : String(err)
    );
    return out;
  }
}

const TURNS_READ = 7;

/** The conversation's turns before the inbound `text`, oldest first. */
export async function loadMeaningTurns(
  conversationId: string,
  text: string
): Promise<MeaningTurn[]> {
  try {
    const { data } = await supabaseAdmin()
      .from('messages')
      .select('sender_type, content_text, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(TURNS_READ);
    const rows = (data ?? []) as {
      sender_type: string;
      content_text: string | null;
    }[];
    // The inbound itself is persisted before the fan-out: drop it.
    if (rows[0]?.sender_type === 'customer' && rows[0].content_text === text)
      rows.shift();
    return rows
      .filter((r) => r.content_text && r.content_text.trim())
      .slice(0, TURNS_READ - 1)
      .reverse()
      .map((r) => ({
        from: r.sender_type === 'customer' ? 'customer' : 'business',
        text: r.content_text as string,
      }));
  } catch {
    return [];
  }
}
