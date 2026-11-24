/**
 * What a composer's send, or a recorded take, carries to `postMessage`,
 * and what happens to the draft once it is posted (276).
 */
import type { postMessage } from './api';
import { draftAfterSend, type ComposerDraft } from './composer';
import { chipInputs, type FileChip } from './composer-input';
import { newPostId, type PostIds } from './post-id';
import type { AttachmentInput } from './types';
import { voiceAttachment } from './voice';

export type PostInput = Parameters<typeof postMessage>[1];

/** A composer's draft as it is sent. */
export function draftPost(
  ids: PostIds,
  draftKey: string,
  i: {
    channelId: string;
    threadRootId: string | null;
    replyToId: string | null;
    body: string;
    chips: readonly FileChip[];
  }
): PostInput {
  return {
    channelId: i.channelId,
    body: i.body,
    threadRootId: i.threadRootId,
    replyToId: i.replyToId ?? undefined,
    attachments: chipInputs(i.chips),
    clientId: ids.idFor(draftKey, {
      body: i.body,
      fileIds: i.chips.map((c) => c.id),
      replyToId: i.replyToId,
      threadRootId: i.threadRootId,
    }),
  };
}

// ---------- a recorded take ----------

/** The part of a take that names its post. */
export interface TakePost {
  /** Names the take's post, so a retry after a lost answer posts it once. */
  postId: string | undefined;
  /** The message that post quotes. */
  replyToId: string | null;
  /** Its finished upload, so a retry does not upload it again. */
  uploaded: AttachmentInput | null;
}

/** One id per take. */
export const newTakePost = (newId = newPostId): TakePost => ({
  postId: newId(),
  replyToId: null,
  uploaded: null,
});

/**
 * The take as Send finds it. Quoting another message makes it another
 * post: under the old id the answer would be the first one, with the old
 * quote, and the file may be the first one's already.
 */
export function takeForSend(
  post: TakePost,
  replyToId: string | null,
  newId = newPostId
): TakePost {
  if (post.replyToId === replyToId) return post;
  return { postId: newId(), replyToId, uploaded: null };
}

export function takePost(
  post: TakePost,
  i: {
    channelId: string;
    threadRootId: string | null;
    body: string;
    uploaded: AttachmentInput;
    durationMs: number;
  }
): PostInput {
  return {
    channelId: i.channelId,
    body: i.body,
    threadRootId: i.threadRootId,
    replyToId: post.replyToId ?? undefined,
    attachments: [voiceAttachment(i.uploaded, i.durationMs)],
    clientId: post.postId,
  };
}

// ---------- posted ----------

/** Tells a draft's mounted composer that the draft was posted by an earlier one. */
export function createPostedNotices() {
  const mounted = new Map<string, Set<(sent: ComposerDraft) => void>>();
  return {
    listen(draftKey: string, fn: (sent: ComposerDraft) => void) {
      const fns = mounted.get(draftKey) ?? new Set();
      mounted.set(draftKey, fns.add(fn));
      return () => {
        fns.delete(fn);
        if (fns.size === 0) mounted.delete(draftKey);
      };
    },
    /** False when no composer of this draft is mounted. */
    tell(draftKey: string, sent: ComposerDraft): boolean {
      const fns = mounted.get(draftKey);
      fns?.forEach((fn) => fn(sent));
      return !!fns;
    },
  };
}

export const postedNotices = createPostedNotices();

/**
 * A draft was posted. A composer left meanwhile keeps the id: the one
 * mounted since may be showing, or sending, the same draft, and that send
 * must stay the same post. It drops what was posted, as the stored draft
 * does when none is mounted; the emptied draft forgets the id.
 */
export function draftPosted(i: {
  ids: PostIds;
  notices: ReturnType<typeof createPostedNotices>;
  draftKey: string;
  sent: ComposerDraft;
  /** The composer that sent it is still mounted. */
  mounted: boolean;
  drop(sent: ComposerDraft): void;
  stored: {
    read(draftKey: string): ComposerDraft;
    write(draftKey: string, draft: ComposerDraft): void;
  };
}): void {
  if (i.mounted) {
    i.ids.forget(i.draftKey);
    i.drop(i.sent);
    return;
  }
  if (i.notices.tell(i.draftKey, i.sent)) return;
  const kept = i.stored.read(i.draftKey);
  const left = draftAfterSend(kept, i.sent);
  if (left !== kept) i.stored.write(i.draftKey, left);
}
