// A stateful stand-in for PostgREST, for the campaign delivery tests.
// It keeps the one behaviour hand-written fakes leave out: a response
// carries at most 1,000 rows.

import type { SupabaseClient } from '@supabase/supabase-js';

import { SEND_UNCONFIRMED_REASON } from '@/lib/broadcasts/unconfirmed-send';

export type Row = Record<string, unknown>;

const MAX_ROWS = 1000;

/** Split on the commas outside parentheses and quotes. */
function splitTerms(expr: string): string[] {
  return expr.match(/(?:"[^"]*"|\((?:"[^"]*"|[^()"])*\)|[^,"()])+/g) ?? [];
}

/** One `col.op.value` or `and(...)` term of an `or=` filter. */
function orTerm(term: string): (r: Row) => boolean {
  const and = /^and\((.*)\)$/.exec(term);
  if (and) {
    const all = splitTerms(and[1]).map(orTerm);
    return (r) => all.every((t) => t(r));
  }
  const [, col, op, value] =
    /^(\w+)\.(is|lt|lte|gte|not\.in)\.(.*)$/.exec(term) ?? [];
  if (op === 'lte') return (r) => r[col] != null && String(r[col]) <= value;
  if (op === 'gte') return (r) => r[col] != null && String(r[col]) >= value;
  if (op === 'is') return (r) => (r[col] ?? null) === null;
  if (op === 'lt') return (r) => r[col] != null && String(r[col]) < value;
  if (op === 'not.in') {
    const listed = [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    return (r) => r[col] != null && !listed.includes(String(r[col]));
  }
  throw new Error(`fake: unsupported or term ${term}`);
}

export interface FakeOptions {
  /** Return a message to fail this request. */
  fail?: (q: { table: string; patch: Row | null }) => string | null;
  /** Called with every update that matched rows. */
  onUpdate?: (table: string, patch: Row, rows: Row[]) => void;
}

export function fakeDb(
  tables: Record<string, Row[]>,
  opts: FakeOptions = {}
): SupabaseClient {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const orders: string[] = [];
      let patch: Row | null = null;
      let start = 0;
      let limit = MAX_ROWS;
      let head = false;
      let memo: { data: Row[] | null; count: number | null; error: unknown };

      const run = () => {
        if (memo) return memo;
        const message = opts.fail?.({ table, patch }) ?? null;
        if (message) {
          return (memo = { data: null, count: null, error: { message } });
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        // broadcast_recipients_stopped_guard (migration 301).
        if (patch?.error_message === SEND_UNCONFIRMED_REASON && !patch.status) {
          rows = rows.filter((r) =>
            (tables.broadcasts ?? []).every(
              (b) =>
                b.id !== r.broadcast_id ||
                b.status === undefined ||
                b.status === 'sending'
            )
          );
        }
        if (patch) {
          for (const r of rows) Object.assign(r, patch);
          if (rows.length) opts.onUpdate?.(table, patch, rows);
        }
        for (const col of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const x = String(a[col] ?? '');
            const y = String(b[col] ?? '');
            return x < y ? -1 : x > y ? 1 : 0;
          });
        }
        const page = rows.slice(start, start + Math.min(limit, MAX_ROWS));
        return (memo = {
          data: head ? null : page.map((r) => ({ ...r })),
          count: rows.length,
          error: null,
        });
      };

      const where = (f: (r: Row) => boolean) => {
        filters.push(f);
        return b;
      };
      const b = {
        select: (_cols?: string, o?: { head?: boolean }) => {
          head = o?.head ?? false;
          return b;
        },
        update: (p: Row) => {
          patch = p;
          return b;
        },
        eq: (c: string, v: unknown) => where((r) => r[c] === v),
        in: (c: string, v: unknown[]) => where((r) => v.includes(r[c])),
        lte: (c: string, v: string) =>
          where((r) => r[c] != null && String(r[c]) <= v),
        gte: (c: string, v: string) =>
          where((r) => r[c] != null && String(r[c]) >= v),
        not: (c: string, op: string, v: unknown) => {
          if (op !== 'is' || v !== null) throw new Error(`fake: not.${op}`);
          return where((r) => (r[c] ?? null) !== null);
        },
        or: (expr: string) => {
          const terms = splitTerms(expr).map(orTerm);
          return where((r) => terms.some((t) => t(r)));
        },
        order: (c: string) => {
          orders.push(c);
          return b;
        },
        limit: (n: number) => {
          limit = n;
          return b;
        },
        range: (from: number, to: number) => {
          start = from;
          limit = to - from + 1;
          return b;
        },
        maybeSingle: async () => {
          const res = run();
          return { data: res.data?.[0] ?? null, error: res.error };
        },
        then: (
          ok: (r: ReturnType<typeof run>) => unknown,
          bad?: (e: unknown) => unknown
        ) => Promise.resolve(run()).then(ok, bad),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}
