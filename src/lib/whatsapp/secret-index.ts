/**
 * Which stored row a webhook secret belongs to, without reading and
 * decrypting every row on every request.
 *
 * The Whapi webhook (and Meta's handshake) authenticate by a per-number
 * secret kept encrypted in `whatsapp_config`. Finding the row meant
 * loading every row of the provider and decrypting each one, for any
 * request from anyone: a loop of `?secret=x` was a cheap way to load the
 * database and the CPU. This index keeps sha256(secret) → row id in
 * memory:
 *
 *   - a hit is answered from memory (the caller then reads that one row
 *     by id and checks the secret again, so a rotated or removed secret
 *     never matches on a stale entry);
 *   - a miss reloads the rows at most once per `minReloadMs` (a new
 *     number's first webhook waits a few seconds at worst, and a flood of
 *     wrong secrets costs one reload per window, not one per request);
 *   - the whole index is refreshed after `ttlMs`;
 *   - `invalidate()` after a save: the new secret's first callback is
 *     looked up afresh instead of refused for the rest of the window;
 *   - a secret that is not found while the last read failed is `failed`
 *     (the route answers 503), not unknown: the sender has to come back.
 *
 * Only hashes of secrets are kept, never the secrets. Never throws.
 */
import { createHash } from 'node:crypto';

export interface SecretIndexDeps<Row> {
  /** Every candidate row; null when the read failed. */
  loadAll: () => Promise<Row[] | null>;
  /** The row's id and its plain secret (null: unusable, skipped). */
  idOf: (row: Row) => string;
  secretOf: (row: Row) => string | null;
  ttlMs?: number;
  minReloadMs?: number;
  now?: () => number;
}

export type SecretLookup =
  { failed: false; id: string | null } | { failed: true; id: null };

const hash = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export class SecretIndex<Row> {
  private byHash = new Map<string, string>();
  private loadedAt = -Infinity;
  private loaded = false;
  private lastReadFailed = false;
  /** Bumped by invalidate(): a read started before it is not kept. */
  private generation = 0;
  private inflight: Promise<boolean> | null = null;

  constructor(private readonly deps: SecretIndexDeps<Row>) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Reloads once even when many requests ask at the same moment. */
  private reload(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const current = () => generation === this.generation;
    const read = (async () => {
      let ok = false;
      try {
        const rows = await this.deps.loadAll();
        if (!rows) return false;
        const next = new Map<string, string>();
        for (const row of rows) {
          let secret: string | null = null;
          try {
            secret = this.deps.secretOf(row);
          } catch {
            secret = null;
          }
          if (secret) next.set(hash(secret), this.deps.idOf(row));
        }
        ok = true;
        if (current()) {
          this.byHash = next;
          this.loaded = true;
        }
        return true;
      } catch {
        return false;
      } finally {
        if (current()) {
          // A failed read also counts: it is not retried on every request.
          this.loadedAt = this.now();
          this.lastReadFailed = !ok;
          this.inflight = null;
        }
      }
    })();
    this.inflight = read;
    return read;
  }

  /** Forget everything (a channel's secret was just changed). */
  invalidate(): void {
    this.generation += 1;
    this.inflight = null;
    this.byHash = new Map();
    this.loaded = false;
    this.lastReadFailed = false;
    this.loadedAt = -Infinity;
  }

  async find(secret: string): Promise<SecretLookup> {
    if (!secret) return { failed: false, id: null };
    const h = hash(secret);
    const age = this.now() - this.loadedAt;
    const ttl = this.deps.ttlMs ?? 60_000;
    const minReload = this.deps.minReloadMs ?? 5_000;
    if (this.loaded && age < ttl && this.byHash.has(h))
      return { failed: false, id: this.byHash.get(h)! };
    if (!this.loaded || age >= ttl || age >= minReload) {
      let generation = this.generation;
      let ok = await this.reload();
      // Saved while that read was running: its answer is not current. A
      // newer read may already be in.
      if (generation !== this.generation) {
        generation = this.generation;
        ok = this.loaded || (await this.reload());
      }
      if (generation !== this.generation || (!ok && !this.loaded))
        return { failed: true, id: null };
    }
    const id = this.byHash.get(h) ?? null;
    if (id === null && this.lastReadFailed) return { failed: true, id: null };
    return { failed: false, id };
  }
}
