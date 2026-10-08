/**
 * Set arithmetic for a broadcast audience over contact ids. The wizard's
 * count (steps 2 and 4) and the send (`resolveAudience`) both go through
 * these, so the number on screen is the number that is sent.
 *
 * An audience is a base list, minus the contacts whose chat carries an
 * excluded chat tag, minus every contact who asked not to be messaged
 * (`contacts.opted_out_at`, migration 076) — whatever the audience type.
 */

export interface AudienceCount {
  /** Contacts the campaign will go to. */
  recipients: number;
  /**
   * Opted-out contacts left out that the audience would otherwise have
   * included (an excluded contact is not counted here).
   */
  optedOut: number;
}

/** Order-preserving dedupe that drops empty ids. */
export function uniqueIds(ids: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const id of ids) if (id) seen.add(id);
  return [...seen];
}

/** Split `items` into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** A base id list (duplicates allowed) after exclusion and opt-out. */
export function countIdAudience(
  baseIds: Iterable<string>,
  excluded: ReadonlySet<string>,
  optedOut: ReadonlySet<string>
): AudienceCount {
  const count: AudienceCount = { recipients: 0, optedOut: 0 };
  for (const id of uniqueIds(baseIds)) {
    if (excluded.has(id)) continue;
    if (optedOut.has(id)) count.optedOut++;
    else count.recipients++;
  }
  return count;
}

/**
 * The whole contact list, known only by its size: every excluded or
 * opted-out id is taken to be one of the `total` contacts (all three
 * are read under the same RLS).
 */
export function countWholeAudience(
  total: number,
  excluded: ReadonlySet<string>,
  optedOut: ReadonlySet<string>
): AudienceCount {
  const skipped = uniqueIds([...excluded, ...optedOut]).length;
  let opted = 0;
  for (const id of optedOut) if (!excluded.has(id)) opted++;
  return { recipients: Math.max(0, total - skipped), optedOut: opted };
}

/**
 * Phone-keyed rows (a CSV upload) that become contacts at send time. A
 * key with no existing contact becomes a new one, which has no chat and
 * never opted out.
 */
export function countPhoneAudience(
  phoneKeys: Iterable<string>,
  existing: ReadonlyMap<string, { id: string; optedOut: boolean }>,
  excluded: ReadonlySet<string>
): AudienceCount {
  const count: AudienceCount = { recipients: 0, optedOut: 0 };
  for (const key of uniqueIds(phoneKeys)) {
    const contact = existing.get(key);
    if (contact && excluded.has(contact.id)) continue;
    if (contact?.optedOut) count.optedOut++;
    else count.recipients++;
  }
  return count;
}

/** The send's final cut: drop excluded and opted-out contacts. */
export function finalAudience<
  T extends { id: string; opted_out_at?: string | null },
>(contacts: readonly T[], excluded: ReadonlySet<string>): T[] {
  return contacts.filter((c) => !excluded.has(c.id) && !c.opted_out_at);
}
