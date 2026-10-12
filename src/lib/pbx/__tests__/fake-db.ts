import type { SupabaseClient } from '@supabase/supabase-js';

// A small in-memory stand-in for the supabase-js query builder: enough
// of select / insert / update / upsert / delete / rpc for the PBX code,
// and storage uploads (kept in `objects`, keyed `<bucket>/<path>`).

export type Row = Record<string, unknown>;
type DbError = { message: string; code?: string };
export type Result = { data: unknown; error: DbError | null; count?: number };
type Rpc = (args: Row) => Result | Promise<Result>;

export interface FakeDb {
  db: SupabaseClient;
  tables: Record<string, Row[]>;
  rpcs: Record<string, Rpc>;
  log: { table: string; op: string; payload?: unknown }[];
  objects: Record<string, { bytes: number; contentType?: string }>;
  /** The next `op` on `table` (`storage:<bucket>` for uploads) answers with this error. */
  fail(table: string, op: string, error: DbError): void;
}

/** null never compares; numbers numerically, anything else as text (ISO times sort). */
function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return NaN;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === 'number' && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

export function createFakeDb(
  tables: Record<string, Row[]> = {},
  rpcs: Record<string, Rpc> = {}
): FakeDb {
  const failures = new Map<string, DbError>();
  const log: FakeDb['log'] = [];

  class Query implements PromiseLike<Result> {
    private op = 'select';
    private payload: unknown;
    private filters: ((r: Row) => boolean)[] = [];
    private mode: 'many' | 'single' | 'maybe' = 'many';
    private sort?: [string, boolean];
    private max?: number;
    private counted = false;
    private head = false;
    private conflict: string[] = [];
    private ignoreDuplicates = false;

    constructor(private table: string) {}

    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (o?.count) this.counted = true;
      if (o?.head) this.head = true;
      return this;
    }
    insert(p: unknown) {
      this.op = 'insert';
      this.payload = p;
      return this;
    }
    update(p: unknown) {
      this.op = 'update';
      this.payload = p;
      return this;
    }
    upsert(
      p: unknown,
      o?: { onConflict?: string; ignoreDuplicates?: boolean }
    ) {
      this.op = 'upsert';
      this.payload = p;
      this.conflict = (o?.onConflict ?? 'id').split(',');
      this.ignoreDuplicates = Boolean(o?.ignoreDuplicates);
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (r[c] ?? null) === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    like(c: string, pattern: string) {
      const re = new RegExp(
        `^${pattern
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.')}$`
      );
      this.filters.push((r) => re.test(String(r[c] ?? '')));
      return this;
    }
    lt(c: string, v: unknown) {
      this.filters.push((r) => cmp(r[c], v) < 0);
      return this;
    }
    lte(c: string, v: unknown) {
      this.filters.push((r) => cmp(r[c], v) <= 0);
      return this;
    }
    /** PostgREST `or`: comma-separated `col.is.null` / `col.lt.v` / `col.lte.v` terms. */
    or(expr: string) {
      const terms = expr.split(',').map((t) => {
        const [c, op, ...rest] = t.split('.');
        const v = rest.join('.');
        if (op === 'is' && v === 'null') return (r: Row) => r[c] == null;
        if (op === 'lt') return (r: Row) => cmp(r[c], v) < 0;
        if (op === 'lte') return (r: Row) => cmp(r[c], v) <= 0;
        throw new Error(`fake-db: unsupported or() term ${t}`);
      });
      this.filters.push((r) => terms.some((f) => f(r)));
      return this;
    }
    not(c: string, _op: 'is', v: unknown) {
      this.filters.push((r) => (r[c] ?? null) !== v);
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) {
      this.sort = [c, o?.ascending !== false];
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    maybeSingle() {
      this.mode = 'maybe';
      return this;
    }
    single() {
      this.mode = 'single';
      return this;
    }
    then<A = Result, B = never>(
      ok?: ((r: Result) => A | PromiseLike<A>) | null,
      ko?: ((e: unknown) => B | PromiseLike<B>) | null
    ): PromiseLike<A | B> {
      return Promise.resolve()
        .then(() => this.run())
        .then(ok, ko);
    }

    private run(): Result {
      log.push({ table: this.table, op: this.op, payload: this.payload });
      const failure = failures.get(`${this.table}:${this.op}`);
      if (failure) {
        failures.delete(`${this.table}:${this.op}`);
        return { data: null, error: failure };
      }
      const rows = (tables[this.table] ??= []);
      const match = (r: Row) => this.filters.every((f) => f(r));
      let data: Row[];
      if (this.op === 'insert' || this.op === 'upsert') {
        const items = (
          Array.isArray(this.payload) ? this.payload : [this.payload]
        ) as Row[];
        // As PostgREST: a duplicate skipped by ignoreDuplicates is not returned.
        data = items.flatMap((item) => {
          const existing =
            this.op === 'upsert'
              ? rows.find((r) => this.conflict.every((k) => r[k] === item[k]))
              : undefined;
          if (existing) {
            if (this.ignoreDuplicates) return [];
            Object.assign(existing, item);
            return [existing];
          }
          const row = { id: crypto.randomUUID(), ...item };
          rows.push(row);
          return [row];
        });
      } else if (this.op === 'update') {
        data = rows.filter(match);
        for (const r of data) Object.assign(r, this.payload);
      } else if (this.op === 'delete') {
        data = rows.filter(match);
        tables[this.table] = rows.filter((r) => !match(r));
      } else {
        data = rows.filter(match);
        if (this.sort) {
          const [c, asc] = this.sort;
          data = [...data].sort(
            (a, b) =>
              String(a[c] ?? '').localeCompare(String(b[c] ?? '')) *
              (asc ? 1 : -1)
          );
        }
        if (this.max !== undefined) data = data.slice(0, this.max);
        if (this.counted) {
          return {
            data: this.head ? null : data,
            error: null,
            count: data.length,
          };
        }
      }
      const copy = data.map((r) => ({ ...r }));
      if (this.mode === 'many') return { data: copy, error: null };
      if (this.mode === 'maybe') return { data: copy[0] ?? null, error: null };
      return copy.length === 1
        ? { data: copy[0], error: null }
        : { data: null, error: { message: 'not one row', code: 'PGRST116' } };
    }
  }

  const objects: FakeDb['objects'] = {};
  const fake: FakeDb = {
    tables,
    rpcs,
    log,
    objects,
    fail: (table, op, error) => failures.set(`${table}:${op}`, error),
    db: {
      from: (table: string) => new Query(table),
      rpc: async (name: string, args: Row) => {
        log.push({ table: `rpc:${name}`, op: 'rpc', payload: args });
        const fn = rpcs[name];
        return fn
          ? fn(args)
          : { data: null, error: { message: `no rpc ${name}` } };
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (
            path: string,
            body: Uint8Array,
            o?: { contentType?: string }
          ) => {
            log.push({
              table: `storage:${bucket}`,
              op: 'upload',
              payload: path,
            });
            const failure = failures.get(`storage:${bucket}:upload`);
            if (failure) {
              failures.delete(`storage:${bucket}:upload`);
              return { data: null, error: failure };
            }
            objects[`${bucket}/${path}`] = {
              bytes: body.byteLength,
              contentType: o?.contentType,
            };
            return { data: { path }, error: null };
          },
        }),
      },
    } as unknown as SupabaseClient,
  };
  return fake;
}
