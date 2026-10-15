// Test-only: an in-memory stand-in for the caller's Supabase client,
// enough of PostgREST's builder for the calendar routes. Filters are
// applied to the rows, so a route that forgets one reads (or writes)
// rows it should not. RLS is not modelled: the fake sees everything,
// as an owner or admin does. `or()` is recorded but not applied (the
// routes use it only to narrow a range buildFeed re-checks).

type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** `table:op` → the error that operation answers with. */
  errors?: Record<string, unknown>;
}

const JOIN: Record<string, [fk: string, pk: string]> = {
  calendar_events: ['event_id', 'id'],
  meetings: ['meeting_id', 'id'],
};

function get(row: Row, col: string): unknown {
  const [a, b] = col.split('.');
  return b === undefined ? row[a] : (row[a] as Row | undefined)?.[b];
}

let seq = 0;

class FakeQuery {
  private preds: ((r: Row) => boolean)[] = [];
  private embed: string | null = null;
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private values: Row | Row[] = {};
  private returning = false;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(cols = '*') {
    if (this.op !== 'select') this.returning = true;
    const m = /^(\w+)!inner\(/.exec(cols);
    if (m) this.embed = m[1];
    return this;
  }
  private where(col: string, test: (v: unknown) => boolean) {
    this.preds.push((r) => test(get(r, col)));
    return this;
  }
  eq(col: string, v: unknown) {
    return this.where(col, (x) => x === v);
  }
  in(col: string, vs: unknown[]) {
    return this.where(col, (x) => vs.includes(x));
  }
  not(col: string, _op: 'is', v: null) {
    return this.where(col, (x) => x !== v && x !== undefined);
  }
  lt(col: string, v: string) {
    return this.where(
      col,
      (x) => x != null && Date.parse(String(x)) < Date.parse(v)
    );
  }
  gt(col: string, v: string) {
    return this.where(
      col,
      (x) => x != null && Date.parse(String(x)) > Date.parse(v)
    );
  }
  gte(col: string, v: string) {
    return this.where(
      col,
      (x) => x != null && Date.parse(String(x)) >= Date.parse(v)
    );
  }
  or() {
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
  delete() {
    this.op = 'delete';
    return this;
  }
  async single() {
    const r = this.run();
    return { data: r.data?.[0] ?? null, error: r.error };
  }
  then<T>(ok: (v: { data: Row[] | null; error: unknown }) => T) {
    return Promise.resolve(this.run()).then(ok);
  }

  private run(): { data: Row[] | null; error: unknown } {
    const error = this.db.errors?.[`${this.table}:${this.op}`];
    if (error) return { data: null, error };
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === 'insert') {
      const added = (
        Array.isArray(this.values) ? this.values : [this.values]
      ).map((v) => ({ id: `${this.table}-${++seq}`, ...v }));
      rows.push(...added);
      return { data: this.returning ? added : null, error: null };
    }
    const match = (r: Row) => this.preds.every((p) => p(r));
    if (this.op === 'delete') {
      this.db.tables[this.table] = rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.values);
      return { data: this.returning ? hit : null, error: null };
    }
    let view = rows;
    if (this.embed) {
      const [fk, pk] = JOIN[this.embed];
      const parents = this.db.tables[this.embed] ?? [];
      view = rows
        .map((r) => ({
          ...r,
          [this.embed!]: parents.find((p) => p[pk] === r[fk]),
        }))
        .filter((r) => r[this.embed!]);
    }
    return { data: view.filter(match), error: null };
  }
}

export function fakeSupabase(db: FakeDb) {
  return { from: (table: string) => new FakeQuery(db, table) };
}
