// ============================================================
// Meaning triggers (Flow `intent`, automation `intent_match`): does the
// customer's message mean what an admin described?
//
//   * Gated: Jev must be available for the account and its Smart
//     insights `meaningTriggersEnabled` switch on. Otherwise nothing is
//     asked and nothing fires.
//   * One request per inbound: the Flows engine and the automation
//     dispatch both judge the same message, so p per candidate key is
//     memoised per (account, gateway message id) for MEMO_TTL_MS. A later
//     caller asks only for the keys not judged yet. A failed request is
//     memoised too (as "no match") rather than retried on the same
//     message, so a slow Jev costs one deadline, not one per engine.
//   * Never throws; any failure means no trigger fires.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { getDecisionLayer } from '@/lib/typesafe';
import { getInsightSettings, insightsAvailable } from './settings';

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
  /** p per candidate key; null when the request for it failed. */
  p: Map<string, Promise<number | null>>;
}

const memo = new Map<string, MemoEntry>();

/** Test hook. */
export function __resetMeaningMemo(): void {
  memo.clear();
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

    const entry = entryFor(input.accountId, input.messageKey);
    const missing = input.candidates.filter((c) => !entry.p.has(c.key));
    if (missing.length > 0) {
      const pending = ask(input, missing);
      missing.forEach((c, i) =>
        entry.p.set(
          c.key,
          pending.then((ps) => ps[i] ?? null)
        )
      );
    }
    for (const c of input.candidates) {
      const p = await entry.p.get(c.key);
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
