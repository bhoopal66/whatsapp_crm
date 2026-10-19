/**
 * Module 018c (port of src/case/presence.ts): "who else is on this case" banner (viewing / typing), in memory, best effort.
 *
 * UI HINT ONLY. It is never used for authorization or for any access decision: a missing or stale entry must never
 * let anyone read or send anything, and a present one grants nothing. Entries live in one process; a restart or a
 * second instance simply shows fewer people.
 *
 *   touch(caseId, actor, state) - records the actor on the case for TTL_MS, only when the injected canRead predicate
 *                                 passes (so the banner does not reveal a case to someone who may not read it).
 *   others(caseId, actor)       - the other actors on the case whose entry has not expired; the asker is excluded.
 * Memory is bounded: expired entries are swept on every touch, and a hard cap per case and globally drops the
 * oldest entries first.
 */
export type PresenceState = 'viewing' | 'typing';

export interface PresenceEntry {
  userId: string;
  state: PresenceState;
  at: Date;
}

export interface CasePresenceOptions {
  /** Whether the actor may read the case (e.g. canReadCase(await CaseStore.role(...))). */
  canRead: (caseId: string, userId: string) => boolean | Promise<boolean>;
  now?: () => Date;
  ttlMs?: number;
  maxPerCase?: number;
  maxTotal?: number;
}

export const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_MAX_PER_CASE = 20;
export const PRESENCE_MAX_TOTAL = 5_000;

export class CasePresence {
  /** caseId -> userId -> entry; Map keeps insertion order, and a touch re-inserts, so the first entry is the oldest. */
  private readonly byCase = new Map<string, Map<string, PresenceEntry>>();
  private total = 0;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxPerCase: number;
  private readonly maxTotal: number;

  constructor(private readonly opts: CasePresenceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
    this.maxPerCase = opts.maxPerCase ?? PRESENCE_MAX_PER_CASE;
    this.maxTotal = opts.maxTotal ?? PRESENCE_MAX_TOTAL;
  }

  /** Records the actor on the case. Returns false (nothing recorded) when canRead refuses. */
  async touch(
    caseId: string,
    actor: { userId: string },
    state: PresenceState
  ): Promise<boolean> {
    if (!(await this.opts.canRead(caseId, actor.userId))) return false;
    const at = this.now();
    this.sweep(at);
    let entries = this.byCase.get(caseId);
    if (!entries) {
      entries = new Map();
      this.byCase.set(caseId, entries);
    }
    if (entries.delete(actor.userId)) this.total--;
    entries.set(actor.userId, { userId: actor.userId, state, at });
    this.total++;
    while (entries.size > this.maxPerCase) this.dropFirst(caseId, entries);
    while (this.total > this.maxTotal) this.dropOldest();
    return true;
  }

  /** The other actors currently on the case (not expired), oldest first. */
  others(caseId: string, actor: { userId: string }): PresenceEntry[] {
    const at = this.now().getTime();
    return [...(this.byCase.get(caseId)?.values() ?? [])]
      .filter(
        (e) => e.userId !== actor.userId && at - e.at.getTime() < this.ttlMs
      )
      .map((e) => ({ ...e }));
  }

  /** Number of entries held (expired ones included until the next sweep). */
  size(): number {
    return this.total;
  }

  private sweep(at: Date): void {
    const t = at.getTime();
    for (const [caseId, entries] of this.byCase) {
      for (const [userId, e] of entries)
        if (t - e.at.getTime() >= this.ttlMs) {
          entries.delete(userId);
          this.total--;
        }
      if (entries.size === 0) this.byCase.delete(caseId);
    }
  }

  private dropFirst(caseId: string, entries: Map<string, PresenceEntry>): void {
    const first = entries.keys().next();
    if (first.done) return;
    entries.delete(first.value);
    this.total--;
    if (entries.size === 0) this.byCase.delete(caseId);
  }

  private dropOldest(): void {
    let oldest: { caseId: string; userId: string; t: number } | null = null;
    for (const [caseId, entries] of this.byCase) {
      const first = entries.values().next();
      if (
        !first.done &&
        (oldest === null || first.value.at.getTime() < oldest.t)
      )
        oldest = {
          caseId,
          userId: first.value.userId,
          t: first.value.at.getTime(),
        };
    }
    if (!oldest) return;
    const entries = this.byCase.get(oldest.caseId)!;
    entries.delete(oldest.userId);
    this.total--;
    if (entries.size === 0) this.byCase.delete(oldest.caseId);
  }
}
