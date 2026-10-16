// Test-only: an in-memory stand-in for a Supabase client, enough of
// PostgREST's builder for the group routes. Filters are applied to the
// rows, so a route that forgets one reads (or writes) rows it should
// not. RLS is not modelled: tests hand the RLS client only the rows the
// caller could see. (Adapted from src/app/api/calendar/test-db.ts.)

type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** `table:op` → the error that operation answers with. */
  errors?: Record<string, unknown>;
  /** Function name → its scripted answer; an unscripted call errors. */
  rpc?: Record<string, (args: Row) => { data?: unknown; error?: unknown }>;
  /** Every write, in order: [table, op, values]. */
  writes?: [table: string, op: string, values: unknown][];
}

type Op = 'select' | 'update' | 'insert' | 'upsert' | 'delete';

let seq = 0;

class FakeQuery {
  private preds: ((r: Row) => boolean)[] = [];
  private op: Op = 'select';
  private values: Row | Row[] = {};
  private returning = false;
  private orderBy: [string, boolean][] = [];
  private max: number | null = null;
  private counting = false;
  private head = false;
  private conflict: string[] = [];
  private ignoreDuplicates = false;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(cols = '*', opts: { count?: 'exact'; head?: boolean } = {}) {
    void cols;
    if (this.op !== 'select') this.returning = true;
    this.counting = opts.count === 'exact';
    this.head = opts.head === true;
    return this;
  }
  private where(col: string, test: (v: unknown) => boolean) {
    this.preds.push((r) => test(r[col]));
    return this;
  }
  eq(col: string, v: unknown) {
    return this.where(col, (x) => x === v);
  }
  neq(col: string, v: unknown) {
    return this.where(col, (x) => x !== v);
  }
  is(col: string, v: null) {
    return this.where(col, (x) => x === v || x === undefined);
  }
  in(col: string, vs: unknown[]) {
    return this.where(col, (x) => vs.includes(x));
  }
  lt(col: string, v: string) {
    return this.where(
      col,
      (x) => x != null && Date.parse(String(x)) < Date.parse(v)
    );
  }
  gte(col: string, v: string) {
    return this.where(
      col,
      (x) => x != null && Date.parse(String(x)) >= Date.parse(v)
    );
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push([col, opts.ascending !== false]);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  update(v: Row) {
    this.op = 'update';
    this.values = v;
    return this;
  }
  insert(v: Row | Row[]) {
    this.op = 'insert';
    this.values = v;
    return this;
  }
  upsert(
    v: Row | Row[],
    opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  ) {
    this.op = 'upsert';
    this.values = v;
    this.conflict = (opts.onConflict ?? 'id').split(',');
    this.ignoreDuplicates = opts.ignoreDuplicates === true;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  async single() {
    const r = this.exec();
    return { data: r.data?.[0] ?? null, error: r.error };
  }
  maybeSingle() {
    return this.single();
  }
  then<T>(
    ok: (v: { data: Row[] | null; error: unknown; count?: number }) => T
  ) {
    return Promise.resolve(this.exec()).then(ok);
  }

  private exec(): { data: Row[] | null; error: unknown; count?: number } {
    const error = this.db.errors?.[`${this.table}:${this.op}`];
    if (error) return { data: null, error };
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op !== 'select') {
      (this.db.writes ??= []).push([this.table, this.op, this.values]);
    }
    const match = (r: Row) => this.preds.every((p) => p(r));
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.values) ? this.values : [this.values];
      const out: Row[] = [];
      for (const v of list) {
        const hit =
          this.op === 'upsert'
            ? rows.find((r) => this.conflict.every((c) => r[c] === v[c]))
            : undefined;
        if (hit) {
          if (!this.ignoreDuplicates) {
            Object.assign(hit, v);
            out.push(hit);
          }
        } else {
          const row = { id: `${this.table}-${++seq}`, ...v };
          rows.push(row);
          out.push(row);
        }
      }
      return { data: this.returning ? out : null, error: null };
    }
    if (this.op === 'delete') {
      const gone = rows.filter(match);
      this.db.tables[this.table] = rows.filter((r) => !match(r));
      return { data: this.returning ? gone : null, error: null };
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.values);
      return { data: this.returning ? hit : null, error: null };
    }
    let view = rows.filter(match);
    for (const [col, asc] of [...this.orderBy].reverse()) {
      view = [...view].sort((a, b) => {
        const x = String(a[col] ?? '');
        const y = String(b[col] ?? '');
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.max !== null) view = view.slice(0, this.max);
    if (this.counting) {
      return { data: this.head ? null : view, error: null, count: view.length };
    }
    return { data: view, error: null };
  }
}

export function fakeSupabase(db: FakeDb) {
  return {
    from: (table: string) => new FakeQuery(db, table),
    async rpc(name: string, args: Row) {
      const handler = db.rpc?.[name];
      if (!handler) {
        return { data: null, error: { code: 'PGRST202', message: name } };
      }
      const { data = null, error = null } = handler(args);
      return { data, error };
    },
  };
}
