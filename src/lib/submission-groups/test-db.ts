// Test-only: an in-memory, read-only stand-in for a Supabase client, enough
// of PostgREST's builder for the Submission Groups read routes. Filters are
// applied to the rows, so a route that forgets one reads rows it should
// not. RLS is not modelled: tests hand the RLS client only the rows the
// caller could see. An `x!inner(...)` embed filtered by `eq('x.col', v)`
// keeps parents with a `tables.x` row whose `group_id` is the parent's id.

type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  rpc?: Record<string, (args: Row) => unknown>;
  /** Every query, as [table, filter description] pairs. */
  log?: [string, string][];
}

const likeRe = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('')
      .map((c) =>
        c === '*' || c === '%'
          ? '.*'
          : c === '_'
            ? '.'
            : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`,
    'i'
  );

const TIME_RE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * A timestamp as microseconds since the epoch, as Postgres compares
 * timestamptz: the fraction read to the microsecond (a `Date` stops at the
 * millisecond), the offset normalised. Anything else falls back to
 * `Date.parse`; null when it is not a time at all.
 */
const toMicros = (v: unknown): number | null => {
  const s = String(v);
  const m = TIME_RE.exec(s);
  if (m) {
    const whole = Date.parse(`${m[1]}${m[3] ?? 'Z'}`);
    return whole * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms * 1000;
};

const isTime = (v: unknown) => /^\d{4}-\d\d-\d\dT/.test(String(v));

/** Splits `a,b(c,d),e` on top-level commas. */
const topLevel = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
};

class FakeQuery {
  private preds: ((r: Row) => boolean)[] = [];
  private orderBy: [string, boolean][] = [];
  private max: number | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  private where(desc: string, p: (r: Row) => boolean) {
    (this.db.log ??= []).push([this.table, desc]);
    this.preds.push(p);
    return this;
  }
  select() {
    return this;
  }
  eq(col: string, v: unknown) {
    const [embed, inner] = col.split('.');
    if (inner)
      return this.where(`${col}=${v}`, (r) =>
        (this.db.tables[embed] ?? []).some(
          (c) => c.group_id === r.id && c[inner] === v
        )
      );
    return this.where(`${col}=${v}`, (r) => r[col] === v);
  }
  is(col: string, v: null) {
    return this.where(`${col} is ${v}`, (r) => r[col] == null);
  }
  in(col: string, vs: unknown[]) {
    return this.where(`${col} in`, (r) => vs.includes(r[col]));
  }
  lt(col: string, v: string) {
    return this.where(
      `${col}<${v}`,
      (r) => r[col] != null && toMicros(r[col])! < toMicros(v)!
    );
  }
  gte(col: string, v: string) {
    return this.where(
      `${col}>=${v}`,
      (r) => r[col] != null && Date.parse(String(r[col])) >= Date.parse(v)
    );
  }
  lte(col: string, v: string) {
    return this.where(
      `${col}<=${v}`,
      (r) => r[col] != null && Date.parse(String(r[col])) <= Date.parse(v)
    );
  }
  ilike(col: string, pattern: string) {
    return this.where(`${col} ilike ${pattern}`, (r) =>
      likeRe(pattern).test(String(r[col] ?? ''))
    );
  }
  or(expr: string) {
    const build = (part: string): ((r: Row) => boolean) => {
      const and = /^and\((.*)\)$/.exec(part);
      if (and) {
        const subs = topLevel(and[1]).map(build);
        return (r) => subs.every((t) => t(r));
      }
      const [col, op, ...rest] = part.split('.');
      const value = rest.join('.');
      if (op === 'lt' || op === 'eq') {
        const time = isTime(value);
        const cmp = (r: Row) => {
          if (r[col] == null) return NaN;
          return time
            ? toMicros(r[col])! - toMicros(value)!
            : String(r[col]) < value
              ? -1
              : String(r[col]) > value
                ? 1
                : 0;
        };
        return op === 'lt' ? (r) => cmp(r) < 0 : (r) => cmp(r) === 0;
      }
      if (op === 'ilike') return (r: Row) => likeRe(value).test(String(r[col]));
      if (op === 'in') {
        const vs = value.replace(/^\(|\)$/g, '').split(',');
        return (r: Row) => vs.includes(String(r[col]));
      }
      throw new Error(`fake or(): unsupported ${part}`);
    };
    const tests = topLevel(expr).map(build);
    return this.where(`or ${expr}`, (r) => tests.some((t) => t(r)));
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push([col, opts.ascending !== false]);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  async maybeSingle() {
    const { data, error } = this.exec();
    return { data: data[0] ?? null, error };
  }
  then<T>(ok: (v: { data: Row[]; error: null }) => T) {
    return Promise.resolve(this.exec()).then(ok);
  }

  private exec(): { data: Row[]; error: null } {
    let view = (this.db.tables[this.table] ?? []).filter((r) =>
      this.preds.every((p) => p(r))
    );
    for (const [col, asc] of [...this.orderBy].reverse()) {
      view = [...view].sort((a, b) => {
        if (isTime(a[col]) && isTime(b[col]))
          return (toMicros(a[col])! - toMicros(b[col])!) * (asc ? 1 : -1);
        const x = String(a[col] ?? '');
        const y = String(b[col] ?? '');
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.max !== null) view = view.slice(0, this.max);
    return { data: view.map((r) => ({ ...r })), error: null };
  }
}

export function fakeSupabase(db: FakeDb) {
  return {
    from: (table: string) => new FakeQuery(db, table),
    async rpc(name: string, args: Row) {
      const handler = db.rpc?.[name];
      if (!handler)
        return { data: null, error: { code: 'PGRST202', message: name } };
      return { data: handler(args), error: null };
    },
  };
}
