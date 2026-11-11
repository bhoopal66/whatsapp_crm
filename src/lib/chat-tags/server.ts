// ============================================================
// Server-side writer for a chat's tags (migration 075). Server use
// only: the caller hands in the client whose rights the write should
// run under — the caller's RLS client from a route, the service role
// from an automation.
//
// It reads the chat's current tags first so the caller can tell what
// changed (a `chat_tag_set` automation fires on arrival, not on
// presence), then writes and reports the row the database returned:
// the guard trigger may have cleared the sub-tag, and RLS answers a
// refused UPDATE with no row rather than an error. Never throws.
//
// The write is a compare-and-set on the tags it read. Two writers on
// one chat (the inbox header, an automation step, a flow node) could
// otherwise both read "untagged", both write X and both report the
// change, so a "when tagged X, send a message" automation messaged the
// customer twice. The loser re-reads once: a chat already at the
// target is reported unchanged (nothing to dispatch), anything else is
// retried from the fresh tags.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChatTagsPatch } from '@/types';

/**
 * What a writer asks for. `chat_sub_tag_id` left undefined means "no
 * sub-tag named": keep the chat's current sub-tag while the main tag
 * stays the same, clear it when the main tag changes (the inbox
 * header's rule). `null` clears it; an id sets it. A `null` main tag
 * clears both.
 */
export interface ChatTagsWrite {
  chat_tag_id: string | null;
  chat_sub_tag_id?: string | null;
}

/** The tags a write leaves on a chat whose current tags are `previous`. */
export function resolveChatTagsWrite(
  previous: ChatTagsPatch,
  next: ChatTagsWrite
): ChatTagsPatch {
  if (next.chat_tag_id === null && next.chat_sub_tag_id === undefined) {
    return { chat_tag_id: null, chat_sub_tag_id: null };
  }
  if (next.chat_sub_tag_id !== undefined) {
    return {
      chat_tag_id: next.chat_tag_id,
      chat_sub_tag_id: next.chat_sub_tag_id,
    };
  }
  return {
    chat_tag_id: next.chat_tag_id,
    chat_sub_tag_id:
      previous.chat_tag_id === next.chat_tag_id
        ? previous.chat_sub_tag_id
        : null,
  };
}

function samePatch(a: ChatTagsPatch, b: ChatTagsPatch): boolean {
  return (
    a.chat_tag_id === b.chat_tag_id && a.chat_sub_tag_id === b.chat_sub_tag_id
  );
}

export type WriteChatTagsResult =
  | {
      ok: true;
      conversationId: string;
      contactId: string;
      previous: ChatTagsPatch;
      saved: ChatTagsPatch;
    }
  | { ok: false; reason: 'not_found' | 'invalid' | 'error'; message?: string };

const COLUMNS = 'id, contact_id, chat_tag_id, chat_sub_tag_id';
const DISMISSED_COLUMN = 'tag_suggestion_dismissed_id';
const BASIS_COLUMN = 'suggestion_basis_at';

interface ChatTagRow {
  id: string;
  contact_id: string;
  chat_tag_id: string | null;
  chat_sub_tag_id: string | null;
  tag_suggestion_dismissed_id?: string | null;
  suggestion_basis_at?: string | null;
}

function toPatch(row: ChatTagRow): ChatTagsPatch {
  return {
    chat_tag_id: row.chat_tag_id ?? null,
    chat_sub_tag_id: row.chat_sub_tag_id ?? null,
  };
}

function failure(error: { code?: string; message?: string }) {
  // 23514: the 075 guard trigger (a sub-tag of another main tag, a sub-
  // tag used as a main tag). 23503: a tag id that is not this account's.
  if (error.code === '23514' || error.code === '23503') {
    return {
      ok: false as const,
      reason: 'invalid' as const,
      message: error.message,
    };
  }
  return {
    ok: false as const,
    reason: 'error' as const,
    message: error.message,
  };
}

export async function writeConversationChatTags(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId?: string;
    contactId?: string;
    next: ChatTagsWrite;
    /**
     * Write only while the chat has no main tag (automatic tagging,
     * docs/jev-insights.md). A chat that is tagged, at the read or by
     * another writer before the compare-and-set lands, is left alone and
     * reported as ok with `previous` equal to `saved` (its real tags):
     * "nothing changed", which dispatches nothing. A person's tag always
     * wins over the automatic one.
     */
    onlyIfUntagged?: boolean;
    /**
     * With `onlyIfUntagged`: write only while the chat's
     * `tag_suggestion_dismissed_id` is still this value (null = none).
     * Automatic tagging decides from a dismissal it read before a Jev
     * call of seconds; a person dismissing the tag meanwhile must win.
     * A mismatch is reported like a tagged chat: ok, nothing changed.
     */
    requireDismissedId?: string | null;
    /**
     * With `onlyIfUntagged`: write only while the chat's
     * `suggestion_basis_at` is NULL or no later than this ISO time (when
     * the automatic decision read the chat), and stamp it with this time.
     * A person who tags and then untags the chat meanwhile leaves the
     * tags as read but moves the basis to their own now(): their decision
     * wins. A later basis is reported like a tagged chat: ok, nothing
     * changed.
     */
    requireBasisAtMost?: string;
  }
): Promise<WriteChatTagsResult> {
  try {
    if (!args.conversationId && !args.contactId) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'A conversation or contact id is required',
      };
    }

    const checkDismissed =
      args.onlyIfUntagged === true && args.requireDismissedId !== undefined;
    const basisMax =
      args.onlyIfUntagged === true ? args.requireBasisAtMost : undefined;
    const columns = [
      COLUMNS,
      ...(checkDismissed ? [DISMISSED_COLUMN] : []),
      ...(basisMax !== undefined ? [BASIS_COLUMN] : []),
    ].join(', ');
    const dismissedMoved = (r: ChatTagRow) =>
      checkDismissed &&
      (r.tag_suggestion_dismissed_id ?? null) !== args.requireDismissedId;
    // Compared as instants: PostgREST answers `+00:00`, the app writes `Z`.
    const basisMoved = (r: ChatTagRow) =>
      basisMax !== undefined &&
      r.suggestion_basis_at != null &&
      Date.parse(r.suggestion_basis_at) > Date.parse(basisMax);
    const decisionMoved = (r: ChatTagRow) => dismissedMoved(r) || basisMoved(r);

    let read = db
      .from('conversations')
      .select(columns)
      .eq('account_id', args.accountId);
    read = args.conversationId
      ? read.eq('id', args.conversationId)
      : // One conversation per contact; should there ever be more, the
        // most recently active one is the chat a person would mean.
        read
          .eq('contact_id', args.contactId as string)
          .is('personal_owner_id', null)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1);
    const { data: current, error: readError } = await read.maybeSingle();
    if (readError) return failure(readError);
    if (!current) return { ok: false, reason: 'not_found' };
    let row = current as unknown as ChatTagRow; // dynamic select list: untyped

    // At most two compare-and-set attempts: the read above, then one
    // fresh read if another writer moved the tags in between.
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = toPatch(row);
      // The compare-and-set below then requires chat_tag_id IS NULL (and
      // the dismissal and the basis still as required).
      if (
        args.onlyIfUntagged &&
        (previous.chat_tag_id !== null || decisionMoved(row))
      ) {
        return {
          ok: true,
          conversationId: row.id,
          contactId: row.contact_id,
          previous,
          saved: previous,
        };
      }
      const target = resolveChatTagsWrite(previous, args.next);
      let update = db
        .from('conversations')
        .update(
          basisMax !== undefined
            ? { ...target, [BASIS_COLUMN]: basisMax }
            : target
        )
        .eq('id', row.id)
        .eq('account_id', args.accountId);
      update =
        previous.chat_tag_id === null
          ? update.is('chat_tag_id', null)
          : update.eq('chat_tag_id', previous.chat_tag_id);
      update =
        previous.chat_sub_tag_id === null
          ? update.is('chat_sub_tag_id', null)
          : update.eq('chat_sub_tag_id', previous.chat_sub_tag_id);
      if (checkDismissed) {
        update =
          args.requireDismissedId === null
            ? update.is('tag_suggestion_dismissed_id', null)
            : update.eq(
                'tag_suggestion_dismissed_id',
                args.requireDismissedId as string
              );
      }
      if (basisMax !== undefined) {
        update = update.or(
          `${BASIS_COLUMN}.is.null,${BASIS_COLUMN}.lte.${basisMax}`
        );
      }
      const { data: written, error: writeError } = await update
        .select(COLUMNS)
        .maybeSingle();
      if (writeError) return failure(writeError);
      if (written) {
        const saved = written as ChatTagRow;
        return {
          ok: true,
          conversationId: saved.id,
          contactId: saved.contact_id,
          previous,
          saved: toPatch(saved),
        };
      }

      // No row back: RLS refused the UPDATE, the chat vanished, or the
      // tags changed since the read. Read again to tell which.
      const { data: fresh, error: freshError } = await db
        .from('conversations')
        .select(columns)
        .eq('account_id', args.accountId)
        .eq('id', row.id)
        .maybeSingle();
      if (freshError) return failure(freshError);
      if (!fresh) return { ok: false, reason: 'not_found' };
      const freshRow = fresh as unknown as ChatTagRow;
      const freshTags = toPatch(freshRow);
      // A dismissal or a newer decision landed meanwhile: the automatic
      // write stands down (the next attempt returns "nothing changed").
      if (decisionMoved(freshRow)) {
        row = freshRow;
        continue;
      }
      // Same tags as before: the condition held, so RLS refused it.
      if (samePatch(freshTags, previous)) {
        return { ok: false, reason: 'not_found' };
      }
      // Another writer already left the chat where this one would:
      // report no change, so nothing dispatches twice.
      if (samePatch(freshTags, resolveChatTagsWrite(freshTags, args.next))) {
        return {
          ok: true,
          conversationId: freshRow.id,
          contactId: freshRow.contact_id,
          previous: freshTags,
          saved: freshTags,
        };
      }
      row = freshRow;
    }

    return {
      ok: false,
      reason: 'error',
      message: 'chat tags changed concurrently',
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
