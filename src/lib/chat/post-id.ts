/**
 * The id a team-chat post carries (276's p_client_id), so that a Send
 * pressed again after a lost answer gets the message already posted
 * instead of posting it twice. One id per draft: the same content sent
 * again keeps it, until the post is confirmed.
 *
 * Changed content gets a new id. The server answers a known id with the
 * FIRST message, so an edited retry under the old id would come back as
 * posted with the edit silently lost. For the same reason an emptied draft
 * is forgotten: the same words typed later are a new message.
 */
export interface PostContent {
  body: string;
  /** The picked files themselves (chip ids): a retried upload has a new storage path. */
  fileIds: readonly string[];
  replyToId: string | null;
  threadRootId: string | null;
}

export interface PostIds {
  /** The id this draft's send carries. `draftKey` is the draft's storage key. */
  idFor(draftKey: string, content: PostContent): string | undefined;
  /** Posted, or emptied: the next send from here is a new message. */
  forget(draftKey: string): void;
}

/**
 * A fresh id, or none: `randomUUID` is missing outside a secure context
 * (plain http on a LAN), where a post goes out without one.
 */
export const newPostId = (): string | undefined =>
  globalThis.crypto?.randomUUID?.();

export function createPostIds(newId = newPostId): PostIds {
  const kept = new Map<string, { content: string; id: string }>();
  return {
    idFor(draftKey, c) {
      const content = JSON.stringify([
        c.body,
        c.fileIds,
        c.replyToId,
        c.threadRootId,
      ]);
      const known = kept.get(draftKey);
      if (known?.content === content) return known.id;
      const id = newId();
      if (id) kept.set(draftKey, { content, id });
      return id;
    },
    forget: (draftKey) => void kept.delete(draftKey),
  };
}

/**
 * The composers' ids, in memory. Outside the component because switching
 * channel unmounts it while the draft is kept, and the draft's id with it.
 */
export const postIds = createPostIds();
