/**
 * A lost upload response is retried under the same idempotency key, and
 * the server (220) answers a known key with the FIRST item without
 * comparing what was sent. So a corrected retry (bank A -> B) is dropped
 * silently. `item.replayed` reaches the client; what the first attempt
 * carried does not, so the form remembers a signature of every attempt it
 * made under a key and compares on a replayed answer. Pure.
 */

export interface UploadAttempt {
  /** The API tag fields (draftToTags), as sent. */
  tags: Record<string, string | null>;
  caption: string;
  file: { name: string; size: number } | null;
}

/** A stable text of everything an upload sends (key order does not matter). */
export function uploadSignature(a: UploadAttempt): string {
  const tags = Object.keys(a.tags)
    .sort()
    .map((k) => [k, a.tags[k] ?? null]);
  return JSON.stringify([
    tags,
    a.caption.trim(),
    a.file ? [a.file.name, a.file.size] : null,
  ]);
}

/**
 * True when the answer is a replay of an earlier attempt whose fields
 * differ from what was sent now: the server kept the first, so the
 * person's correction has not been applied.
 */
export function replayDropsChange(
  replayed: boolean,
  firstSignature: string | null,
  sentSignature: string
): boolean {
  return (
    replayed && firstSignature !== null && firstSignature !== sentSignature
  );
}
