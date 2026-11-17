/**
 * Pure planning for `scripts/repair-openwa-media.ts`.
 *
 * Before `mirrorKey` (`mirror-inbound-media.ts`), every OpenWA attachment
 * of one chat with the same extension was mirrored to ONE chat-media
 * object, each upload overwriting the last, so the messages all point at
 * whichever file arrived last. The repair fetches each message's own file
 * from OpenWA again and gives it its own object. This module decides
 * what to do; the script does the I/O.
 */

/**
 * The OpenWA media id (`<chat>/<message id>`, `toOpenWAMediaId`) for a
 * stored inbound message id. whatsapp-web.js serialises an id as
 * `<fromMe>_<chat jid>_<hash>`, and the chat of a 1:1 inbound message is
 * the jid in the middle. Null for anything else.
 */
export function openwaMediaIdFor(messageId: string): string | null {
  const m = /^(?:true|false)_([^_@/]+@[a-z.]+)_([A-Za-z0-9]+)$/.exec(messageId);
  return m ? `${m[1]}/${messageId}` : null;
}

/** Status of a `customer_documents` row (178's CHECK). */
export type DocStatus = 'pending' | 'stored' | 'duplicate' | 'failed';

export interface DocRow {
  id: string;
  status: DocStatus;
  /** What the worker hashed: the shared object's bytes at copy time. */
  sha256: string | null;
}

/**
 * What to do with one NAS-archive row of an affected message, given the
 * sha256 of that message's real file and of the NAS file the row names
 * (null when it has none or it could not be read).
 *
 * - `keep`: only the link changes. A stored row whose file already holds
 *   the right bytes, or a row the worker has not copied yet.
 * - `reset`: back to pending, so the worker copies the right file.
 * - `quarantine`: the NAS file holds another document's bytes under this
 *   document's name; move it aside, then reset.
 *
 * A duplicate is always reset: it names the file of the row it was
 * matched to, and that match was made on the wrong bytes. The worker
 * re-matches it on the real ones.
 */
export function planDocRepair(
  doc: DocRow,
  realSha: string,
  nasFileSha: string | null
): 'keep' | 'reset' | 'quarantine' {
  switch (doc.status) {
    case 'pending':
      return 'keep';
    case 'failed':
    case 'duplicate':
      return 'reset';
    case 'stored':
      if (doc.sha256 === realSha && nasFileSha === realSha) return 'keep';
      return nasFileSha === null ? 'reset' : 'quarantine';
  }
}

/** A SQL string literal. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
