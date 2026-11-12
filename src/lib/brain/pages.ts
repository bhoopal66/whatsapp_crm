/**
 * Ported from wacrm module 022c (second brain pages): one living,
 * AI-generated summary page per case, contact and bank. Pages are built from
 * the "staff" visibility class of items (live, unrestricted, contact
 * unmarked) and filtered at read: brain_page_read returns a page only when
 * EVERY item it was built from is visible to the actor (fail closed), and a
 * page that fails that check is indistinguishable from one that does not
 * exist (no rows).
 *
 * SupabaseBrainPageStore calls the brain_page_* SECURITY DEFINER functions
 * on the service role (callers pass `supabaseAdmin()`); errors go through
 * brainFail, so a stale version arrives as BrainError reason 'CONFLICT'.
 * No scheduler: rebuildDirtyPages is called by a route or a job.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { date, rows, str } from '@/lib/cases/store';

import {
  BRAIN_SOURCE_KINDS,
  type BrainCitation,
  type BrainSourceKind,
  type BrainWriter,
} from './ports';
import { BrainError, brainRpc, brainScalar } from './store';

export type BrainPageKind = 'case' | 'contact' | 'bank';
export const BRAIN_PAGE_KINDS: readonly BrainPageKind[] = [
  'case',
  'contact',
  'bank',
];
export const PAGE_SOURCE_CAP = 200;
export const PAGE_HEADER = 'AI-generated summary - verify against the case';

export interface PageSourceItem {
  id: string;
  text: string;
  createdAt: Date;
  sourceKind: string;
}

export interface Summariser {
  summarise(
    kind: BrainPageKind,
    items: readonly PageSourceItem[]
  ): Promise<string>;
}

export interface BrainPageView {
  summary: string;
  version: number;
  builtAt: Date | null;
  /** The source items the summary actually cites, never others. */
  citations: BrainCitation[];
}

export interface DirtyPage {
  kind: BrainPageKind;
  key: string;
  version: number;
}

export interface BrainPageStore {
  markDirty(accountId: string, itemIds: readonly string[]): Promise<number>;
  dirty(accountId: string, limit: number): Promise<DirtyPage[]>;
  remaining(accountId: string): Promise<number>;
  version(
    accountId: string,
    kind: BrainPageKind,
    key: string
  ): Promise<number | null>;
  sources(
    accountId: string,
    kind: BrainPageKind,
    key: string,
    limit: number
  ): Promise<PageSourceItem[]>;
  put(
    accountId: string,
    kind: BrainPageKind,
    key: string,
    expectedVersion: number,
    summary: string,
    itemIds: readonly string[]
  ): Promise<number>;
  read(
    actorId: string,
    accountId: string,
    kind: BrainPageKind,
    key: string
  ): Promise<BrainPageView | null>;
  forget(
    by: BrainWriter,
    accountId: string,
    contactId: string,
    reason: string
  ): Promise<number>;
}

/** `[item:<first 8 hex of the uuid>]`, the marker a fact line starts with. */
export const citeMarker = (id: string): string =>
  `[item:${id.replace(/-/g, '').slice(0, 8)}]`;
const CITE_RE = /\[item:[0-9a-f]{8}\]/g;

const oneLine = (t: string, n: number): string => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
};
const TASK_RE = /\b(task|todo|to do|pending|follow[- ]up|awaiting)\b/i;

/**
 * Deterministic extractive stub: newest first - last stage change, open tasks
 * mentioned (<= 5), last 3 messages (<= 120 chars each), pinned info on a bank
 * page (<= 5). Every fact line starts with its [item:<id8>] citation. It
 * cannot tell a customer's message from a staff member's and emits no dates.
 */
export class ExtractiveSummariser implements Summariser {
  async summarise(
    kind: BrainPageKind,
    items: readonly PageSourceItem[]
  ): Promise<string> {
    const xs = [...items].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const lines = [PAGE_HEADER];
    const stage = xs.find(
      (i) => i.sourceKind === 'timeline' && /^Stage changed/i.test(i.text)
    );
    if (stage)
      lines.push(
        `${citeMarker(stage.id)} Last stage change: ${oneLine(stage.text, 160)}`
      );
    for (const t of xs
      .filter((i) => i.sourceKind !== 'timeline' && TASK_RE.test(i.text))
      .slice(0, 5))
      lines.push(
        `${citeMarker(t.id)} Open task mentioned: ${oneLine(t.text, 160)}`
      );
    for (const m of xs.filter((i) => i.sourceKind === 'message').slice(0, 3))
      lines.push(`${citeMarker(m.id)} Message: ${oneLine(m.text, 120)}`);
    if (kind === 'bank')
      for (const p of xs.filter((i) => i.sourceKind === 'pinned').slice(0, 5))
        lines.push(`${citeMarker(p.id)} Pinned: ${oneLine(p.text, 160)}`);
    if (lines.length === 1) lines.push('No facts extracted yet.');
    return lines.join('\n');
  }
}

const KINDS: ReadonlySet<string> = new Set(BRAIN_SOURCE_KINDS);
const PAGE_KINDS: ReadonlySet<string> = new Set(BRAIN_PAGE_KINDS);
const int = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/** The page's sources that its summary cites, in order of first mention. */
export function pageCitations(
  summary: string,
  sources: unknown
): BrainCitation[] {
  const byMarker = new Map<string, BrainCitation>();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s === null || typeof s !== 'object') continue;
    const id = str((s as Record<string, unknown>).id);
    const kind = str((s as Record<string, unknown>).kind);
    if (!id || !kind || !KINDS.has(kind)) continue;
    const m = citeMarker(id);
    if (!byMarker.has(m))
      byMarker.set(m, { kind: kind as BrainSourceKind, id });
  }
  const out: BrainCitation[] = [];
  for (const m of new Set(summary.match(CITE_RE) ?? [])) {
    const c = byMarker.get(m);
    if (c) out.push(c);
  }
  return out;
}

export class SupabaseBrainPageStore implements BrainPageStore {
  constructor(private readonly db: SupabaseClient) {}

  async markDirty(
    accountId: string,
    itemIds: readonly string[]
  ): Promise<number> {
    const data = await brainRpc(this.db, 'brain_page_mark_dirty', {
      p_account: accountId,
      p_item_ids: [...itemIds],
    });
    return int(brainScalar(data)) ?? 0;
  }

  async dirty(accountId: string, limit: number): Promise<DirtyPage[]> {
    const data = await brainRpc(this.db, 'brain_page_dirty_list', {
      p_account: accountId,
      p_limit: limit,
    });
    const out: DirtyPage[] = [];
    for (const r of rows(data)) {
      const kind = str(r.kind);
      const key = str(r.key);
      const version = int(r.version);
      if (!kind || !PAGE_KINDS.has(kind) || !key || version === null) continue;
      out.push({ kind: kind as BrainPageKind, key, version });
    }
    return out;
  }

  async remaining(accountId: string): Promise<number> {
    const data = await brainRpc(this.db, 'brain_page_dirty_count', {
      p_account: accountId,
    });
    return int(brainScalar(data)) ?? 0;
  }

  async version(
    accountId: string,
    kind: BrainPageKind,
    key: string
  ): Promise<number | null> {
    const data = await brainRpc(this.db, 'brain_page_version', {
      p_account: accountId,
      p_kind: kind,
      p_key: key,
    });
    return int(brainScalar(data));
  }

  async sources(
    accountId: string,
    kind: BrainPageKind,
    key: string,
    limit: number
  ): Promise<PageSourceItem[]> {
    const data = await brainRpc(this.db, 'brain_page_sources', {
      p_account: accountId,
      p_kind: kind,
      p_key: key,
      p_limit: limit,
    });
    const out: PageSourceItem[] = [];
    for (const r of rows(data)) {
      const id = str(r.item_id);
      const createdAt = date(r.created_at);
      if (!id || !createdAt || Number.isNaN(createdAt.getTime())) continue;
      out.push({
        id,
        text: str(r.text) ?? '',
        createdAt,
        sourceKind: str(r.source_kind) ?? '',
      });
    }
    return out;
  }

  async put(
    accountId: string,
    kind: BrainPageKind,
    key: string,
    expectedVersion: number,
    summary: string,
    itemIds: readonly string[]
  ): Promise<number> {
    const data = await brainRpc(this.db, 'brain_page_put', {
      p_account: accountId,
      p_kind: kind,
      p_key: key,
      p_expected_version: expectedVersion,
      p_summary: summary,
      p_item_ids: [...itemIds],
    });
    const v = int(brainScalar(data));
    if (v === null) throw new BrainError('brain_page_put', null, null);
    return v;
  }

  async read(
    actorId: string,
    accountId: string,
    kind: BrainPageKind,
    key: string
  ): Promise<BrainPageView | null> {
    const data = await brainRpc(this.db, 'brain_page_read', {
      p_actor: actorId,
      p_account: accountId,
      p_kind: kind,
      p_key: key,
    });
    const r = rows(data)[0];
    if (!r) return null;
    const summary = str(r.summary) ?? '';
    const builtAt = date(r.built_at);
    return {
      summary,
      version: int(r.version) ?? 0,
      builtAt: builtAt && !Number.isNaN(builtAt.getTime()) ? builtAt : null,
      citations: pageCitations(summary, r.sources),
    };
  }

  /**
   * Deletes the contact's page and wipes every page built from its items.
   * A person (`actorId`) or a job (`actorId: null` + `system:retention` /
   * `system:erasure`), as brain_item_forget.
   */
  async forget(
    by: BrainWriter,
    accountId: string,
    contactId: string,
    reason: string
  ): Promise<number> {
    const data = await brainRpc(this.db, 'brain_page_forget', {
      p_actor: by.actorId,
      p_system_label: by.systemLabel ?? null,
      p_account: accountId,
      p_contact: contactId,
      p_reason: reason,
    });
    return int(brainScalar(data)) ?? 0;
  }
}

/**
 * Rebuild up to `limit` dirty pages of the account, oldest dirty first:
 * sources (<= 200, newest first) -> summariser -> put with the expected
 * version; one retry (fresh version and sources) on CONFLICT. A failing page
 * is counted, never thrown.
 */
export async function rebuildDirtyPages(o: {
  store: BrainPageStore;
  summariser: Summariser;
  accountId: string;
  limit: number;
}): Promise<{ rebuilt: number; failed: number; remaining: number }> {
  const { store, summariser, accountId } = o;
  let rebuilt = 0;
  let failed = 0;
  for (const p of await store.dirty(accountId, o.limit)) {
    try {
      let version: number | null = p.version;
      for (let attempt = 0; ; attempt++) {
        if (version === null) throw new Error('page gone');
        const items = await store.sources(
          accountId,
          p.kind,
          p.key,
          PAGE_SOURCE_CAP
        );
        const summary = await summariser.summarise(p.kind, items);
        try {
          await store.put(
            accountId,
            p.kind,
            p.key,
            version,
            summary,
            items.map((i) => i.id)
          );
          break;
        } catch (e) {
          if (
            attempt === 0 &&
            e instanceof BrainError &&
            e.reason === 'CONFLICT'
          ) {
            version = await store.version(accountId, p.kind, p.key);
            continue;
          }
          throw e;
        }
      }
      rebuilt++;
    } catch {
      failed++;
    }
  }
  return { rebuilt, failed, remaining: await store.remaining(accountId) };
}
