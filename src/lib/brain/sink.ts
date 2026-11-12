/**
 * Ported from wacrm module 022b: the BrainSink, best-effort ingestion of a
 * write that has already succeeded (a case note, a staff reply, customer
 * text in a case's group, a bank pin / thread / post, a stage change).
 *
 * `record()` returns a promise that never rejects: every failure is
 * swallowed, logged once without the text and counted. Callers await it
 * INSIDE Next's `after()` (never as a floating promise: the runtime kills
 * detached work, issues #301/#409) and never change their response.
 * While the account's switch (`case_account_settings.brain_enabled`, 194;
 * no row = off) is off it does nothing: no embedding, no RPC. A message of
 * an opted-out / deletion-marked contact is not ingested and is counted in
 * `brain_ingest_skipped_marked`, as in the package.
 * Never ingested: vault items, documents/files, media, the take-over
 * hand-over template text: no caller hands those to the sink.
 */
import { supabaseAdmin } from '@/lib/submission-groups/server';
import {
  ingestDiscussion,
  ingestMessage,
  ingestNote,
  ingestPinned,
  ingestTimelineEvent,
  type IngestDeps,
  type IngestResult,
  type SourceRef,
} from './ingest';
import { HashingEmbedder } from './embed';
import { SupabaseBrainPageStore, type BrainPageStore } from './pages';
import { SupabaseBrainStore, SupabaseCosineIndex } from './store';

export type SinkEvent =
  | { kind: 'message'; ref: SourceRef; messageId: string; text: string }
  | { kind: 'note'; ref: SourceRef; noteId: string; body: string }
  | { kind: 'timeline'; ref: SourceRef; eventId: string; summary: string }
  | { kind: 'pinned'; ref: SourceRef; pinId: string; text: string }
  | { kind: 'discussion'; ref: SourceRef; postId: string; body: string };

export interface SinkDeps extends IngestDeps {
  /** The account's brain switch; a missing settings row is off. */
  enabled: (accountId: string) => Promise<boolean>;
  /** True when the contact is opted out / deletion-marked in the account. */
  marked: (accountId: string, contactId: string) => Promise<boolean>;
  /** 022c: pages built from freshly stored items are marked dirty. */
  pages?: Pick<BrainPageStore, 'markDirty'>;
}

export interface BrainSink {
  record(event: SinkEvent): Promise<void>;
}

/** In-process counters (the package's names). */
export const brainSinkCounters = {
  brain_ingest_failures: 0,
  brain_ingest_skipped_marked: 0,
  brain_page_dirty_failures: 0,
};

/**
 * 022c: mark the pages built from `itemIds` dirty. Never rejects: a failure
 * is counted in `brain_page_dirty_failures` and logged without any text.
 */
export async function markPagesDirty(
  pages: Pick<BrainPageStore, 'markDirty'> | undefined,
  accountId: string,
  itemIds: readonly string[]
): Promise<void> {
  if (!pages || itemIds.length === 0) return;
  try {
    await pages.markDirty(accountId, itemIds);
  } catch (err) {
    brainSinkCounters.brain_page_dirty_failures++;
    try {
      console.warn(
        '[brain-sink] page dirty mark failed',
        err instanceof Error ? err.name : typeof err
      );
    } catch {
      // a logger must never reach the caller either
    }
  }
}

export class BestEffortBrainSink implements BrainSink {
  constructor(private readonly deps: SinkDeps) {}

  async record(event: SinkEvent): Promise<void> {
    try {
      if (!(await this.deps.enabled(event.ref.accountId))) return;
      const r = await this.ingest(event);
      if (r !== null && !r.ok) this.fail(event.kind, r.reason);
      else if (r !== null)
        await markPagesDirty(this.deps.pages, event.ref.accountId, r.itemIds);
    } catch (err) {
      this.fail(event.kind, err instanceof Error ? err.message : 'error');
    }
  }

  private fail(kind: string, reason: string) {
    brainSinkCounters.brain_ingest_failures++;
    try {
      console.warn('[brain-sink]', kind, reason);
    } catch {
      // a logger must never reach the caller either
    }
  }

  private async ingest(ev: SinkEvent): Promise<IngestResult | null> {
    const d = this.deps;
    switch (ev.kind) {
      case 'message':
        if (
          ev.ref.contactId &&
          (await d.marked(ev.ref.accountId, ev.ref.contactId))
        ) {
          brainSinkCounters.brain_ingest_skipped_marked++;
          return null;
        }
        return ingestMessage(d, {
          ...ev.ref,
          messageId: ev.messageId,
          text: ev.text,
        });
      case 'note':
        return ingestNote(d, { ...ev.ref, noteId: ev.noteId, body: ev.body });
      case 'timeline':
        return ingestTimelineEvent(d, {
          ...ev.ref,
          eventId: ev.eventId,
          summary: ev.summary,
        });
      case 'pinned':
        return ingestPinned(d, { ...ev.ref, pinId: ev.pinId, text: ev.text });
      case 'discussion':
        return ingestDiscussion(d, {
          ...ev.ref,
          postId: ev.postId,
          body: ev.body,
        });
    }
  }
}

/**
 * A moved stage as a timeline event (generated text only; stage names come
 * from admin settings). StageResult carries no stage-history id, so the
 * source id is `<case>:<to>:<time>`. NULL for a no-op move.
 */
export function stageChangedEvent(
  ref: SourceRef & { caseId: string },
  r: { moved: boolean; fromStage: string | null; toStage: string },
  at: Date = new Date()
): SinkEvent | null {
  if (!r.moved) return null;
  return {
    kind: 'timeline',
    ref,
    eventId: `${ref.caseId}:${r.toStage}:${at.toISOString()}`,
    summary: `Stage changed from ${r.fromStage ?? 'none'} to ${r.toStage}`,
  };
}

/**
 * A customer's text in a submission group (recordSubmissionGroupInbound's
 * `customerText` hook): ingested only when the group has a case, as the
 * system writer `system:inbound`. Never rejects.
 */
export async function recordGroupCustomerText(m: {
  accountId: string;
  groupId: string;
  waMessageId: string;
  body: string;
}): Promise<void> {
  try {
    // The switch first: most accounts have it off, and this runs on every
    // customer text in a group, so the `cases` lookup waits for it.
    const deps = sinkDeps();
    if (!(await deps.enabled(m.accountId))) return;
    const { data, error } = await supabaseAdmin()
      .from('cases')
      .select('id, contact_id, bank_code')
      .eq('account_id', m.accountId)
      .eq('group_id', m.groupId)
      .maybeSingle();
    if (error) throw new Error(`case for group: ${error.message}`);
    const c = data as {
      id: string;
      contact_id: string | null;
      bank_code: string | null;
    } | null;
    if (!c) return;
    // The switch was read above; do not read it twice.
    await new BestEffortBrainSink({
      ...deps,
      enabled: async () => true,
    }).record({
      kind: 'message',
      ref: {
        accountId: m.accountId,
        caseId: c.id,
        contactId: c.contact_id ?? null,
        bankCode: c.bank_code ?? null,
        createdBy: null,
        systemLabel: 'system:inbound',
      },
      messageId: m.waMessageId,
      text: m.body,
    });
  } catch (err) {
    brainSinkCounters.brain_ingest_failures++;
    console.warn(
      '[brain-sink]',
      'message',
      err instanceof Error ? err.message : 'error'
    );
  }
}

/** The service-role wiring (to be folded into brain/server.ts later). */
export function sinkDeps(): SinkDeps {
  const db = supabaseAdmin();
  return {
    store: new SupabaseBrainStore(db),
    index: new SupabaseCosineIndex(db),
    embedder: new HashingEmbedder(),
    pages: new SupabaseBrainPageStore(db),
    enabled: async (accountId) => {
      const { data, error } = await db
        .from('case_account_settings')
        .select('brain_enabled')
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) throw new Error(`brain_enabled read: ${error.message}`);
      return (
        (data as { brain_enabled?: unknown } | null)?.brain_enabled === true
      );
    },
    marked: async (accountId, contactId) => {
      const { data, error } = await db.rpc('brain_contact_marked', {
        p_account: accountId,
        p_contact: contactId,
      });
      if (error) throw new Error(`brain_contact_marked: ${error.message}`);
      return data === true;
    },
  };
}

/** A sink over the service-role client; build failures are swallowed too. */
export function brainSink(): BrainSink {
  try {
    return new BestEffortBrainSink(sinkDeps());
  } catch (err) {
    return {
      record: async (ev) => {
        brainSinkCounters.brain_ingest_failures++;
        console.warn(
          '[brain-sink]',
          ev.kind,
          err instanceof Error ? err.message : 'error'
        );
      },
    };
  }
}
