/**
 * Ported from wacrm module 022a (second brain): ingest. Each function
 * redacts the source text (redact.ts), chunks it (<= 800 chars on sentence
 * boundaries), upserts every chunk (idempotent per source + chunk hash) and
 * embeds the stored chunks. A redactor refusal stores nothing. Chunks of a
 * forgotten source or of an opted-out / deletion-marked contact, and every
 * chunk while the account's brain switch is off, are not stored (the upsert
 * returns null) and are not embedded.
 * Never ingested: vault items and case document files (ID documents) - this
 * module has no path from either.
 */
import type {
  BrainItemInput,
  BrainRestrictedRole,
  BrainSourceKind,
  BrainStore,
  Embedder,
  VectorIndex,
} from './ports';
import { brainRedact } from './redact';
import { chunkText } from './chunk';

export interface IngestDeps {
  store: BrainStore;
  index: VectorIndex;
  embedder: Embedder;
}

export type IngestResult =
  | { ok: true; itemIds: string[]; skipped: number }
  | { ok: false; reason: string };

/** Fields every source carries besides its text. */
export interface SourceRef {
  accountId: string;
  caseId?: string | null;
  contactId?: string | null;
  bankCode?: string | null;
  aiGenerated?: boolean;
  restrictedRole?: BrainRestrictedRole | null;
  /** The person who wrote it; null with a `systemLabel` for a system writer. */
  createdBy?: string | null;
  systemLabel?: string | null;
}

async function ingest(
  deps: IngestDeps,
  kind: BrainSourceKind,
  sourceId: string,
  ref: SourceRef,
  text: string
): Promise<IngestResult> {
  const red = brainRedact(text);
  if (!red.ok) return { ok: false, reason: red.reason };
  const chunks = chunkText(red.text);
  const stored: { id: string; text: string }[] = [];
  let skipped = 0;
  for (const chunk of chunks) {
    const item: BrainItemInput = {
      accountId: ref.accountId,
      sourceKind: kind,
      sourceId,
      caseId: ref.caseId ?? null,
      contactId: ref.contactId ?? null,
      bankCode: ref.bankCode ?? null,
      text: chunk,
      aiGenerated: ref.aiGenerated ?? false,
      restrictedRole: ref.restrictedRole ?? null,
      createdBy: ref.createdBy ?? null,
      systemLabel: ref.systemLabel ?? null,
    };
    const id = await deps.store.upsert(item);
    if (id === null) skipped++;
    else stored.push({ id, text: chunk });
  }
  if (stored.length > 0) {
    const vecs = await deps.embedder.embed(stored.map((s) => s.text));
    for (const [i, s] of stored.entries()) {
      const vec = vecs[i];
      if (!vec)
        throw new Error(
          'brain ingest: the embedder returned fewer vectors than texts'
        );
      await deps.index.put(ref.accountId, s.id, deps.embedder.model, vec);
    }
  }
  return { ok: true, itemIds: stored.map((s) => s.id), skipped };
}

export const ingestMessage = (
  deps: IngestDeps,
  m: SourceRef & { messageId: string; text: string }
) => ingest(deps, 'message', m.messageId, m, m.text);

export const ingestNote = (
  deps: IngestDeps,
  n: SourceRef & { noteId: string; body: string }
) => ingest(deps, 'note', n.noteId, n, n.body);

export const ingestTimelineEvent = (
  deps: IngestDeps,
  e: SourceRef & { eventId: string; summary: string }
) => ingest(deps, 'timeline', e.eventId, e, e.summary);

export const ingestPinned = (
  deps: IngestDeps,
  p: SourceRef & { pinId: string; text: string }
) => ingest(deps, 'pinned', p.pinId, p, p.text);

export const ingestDiscussion = (
  deps: IngestDeps,
  d: SourceRef & { postId: string; body: string }
) => ingest(deps, 'discussion', d.postId, d, d.body);

/** A staff member's "remember this": source id = the actor, so the same text remembered twice is stored once. */
export const ingestRemember = (
  deps: IngestDeps,
  actorId: string,
  text: string,
  ref: Omit<SourceRef, 'createdBy' | 'systemLabel'>
) =>
  ingest(
    deps,
    'remember',
    actorId,
    { ...ref, createdBy: actorId, systemLabel: null },
    text
  );
