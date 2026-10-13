/**
 * Test-only: an in-memory stand-in for the supabase-js query builder,
 * as much of it as the deal-room tests need (eq / neq / is / in / like /
 * lt / lte / gte, order, limit, insert, update, maybeSingle, single, and
 * `storage.from(bucket)`: upload, createSignedUrl, remove). Updates
 * mutate the stored rows; reads return copies, so a run that read a row
 * earlier holds a stale snapshot, as it would against Postgres. Column lists and embeds are
 * not parsed: a row comes back whole, so seed an embed as a nested
 * object.
 */

type Row = Record<string, unknown>;

export interface QueryLog {
  table: string;
  op: 'select' | 'insert' | 'update';
  /** The `eq` filters, by column. */
  eq: Row;
  values: Row | Row[] | null;
}

export interface MemoryDbOptions {
  /** Answers `db.rpc`; a thrown `{ code?, message }` becomes the error. */
  rpc?: (fn: string, params: Row) => unknown;
  /** Runs just before an update applies: a racing writer goes here. */
  beforeUpdate?: (table: string, values: Row) => void;
  /** Answers a storage upload; a thrown `{ message }` becomes the error. */
  upload?: (bucket: string, path: string) => void;
}

export interface UploadLog {
  bucket: string;
  path: string;
  bytes: Uint8Array;
  options: Row | undefined;
}

export function memoryDb(
  tables: Record<string, Row[]>,
  opts: MemoryDbOptions = {}
) {
  const log: QueryLog[] = [];
  const rpcCalls: [string, Row][] = [];
  const uploads: UploadLog[] = [];
  const removed: { bucket: string; paths: string[] }[] = [];

  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: ((r: Row) => boolean)[] = [];
    const eq: Row = {};
    let op: QueryLog['op'] = 'select';
    let values: Row | Row[] | null = null;
    let returning = false;
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;

    const run = (): Row[] | null => {
      log.push({ table, op, eq, values });
      if (op === 'insert') {
        const list = Array.isArray(values) ? values : [values as Row];
        rows.push(...list.map((r) => ({ ...r })));
        return returning ? list : null;
      }
      if (op === 'update') opts.beforeUpdate?.(table, values as Row);
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        for (const r of hit) Object.assign(r, values);
        return returning ? hit.map((r) => ({ ...r })) : null;
      }
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort(
          (a, b) =>
            String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1)
        );
      }
      return hit.slice(0, limit).map((r) => ({ ...r }));
    };

    const builder: Record<string, unknown> = {};
    const chain = (fn: () => void) => {
      fn();
      return builder;
    };
    builder.select = () =>
      chain(() => {
        if (op !== 'select') returning = true;
      });
    builder.eq = (col: string, v: unknown) =>
      chain(() => {
        eq[col] = v;
        filters.push((r) => r[col] === v);
      });
    builder.neq = (col: string, v: unknown) =>
      chain(() => filters.push((r) => r[col] !== v));
    builder.is = (col: string, v: unknown) =>
      chain(() => filters.push((r) => (r[col] ?? null) === v));
    builder.in = (col: string, vs: unknown[]) =>
      chain(() => filters.push((r) => vs.includes(r[col])));
    // SQL LIKE: `%` is any run of characters, `_` any one.
    builder.like = (col: string, pattern: string) =>
      chain(() => {
        const re = new RegExp(
          `^${pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.')}$`,
          's'
        );
        filters.push(
          (r) => typeof r[col] === 'string' && re.test(r[col] as string)
        );
      });
    builder.lt = (col: string, v: unknown) =>
      chain(() => filters.push((r) => String(r[col]) < String(v)));
    builder.lte = (col: string, v: unknown) =>
      chain(() => filters.push((r) => String(r[col]) <= String(v)));
    // As SQL: a NULL is never greater or equal.
    builder.gte = (col: string, v: unknown) =>
      chain(() =>
        filters.push((r) => r[col] != null && String(r[col]) >= String(v))
      );
    builder.order = (col: string, o?: { ascending?: boolean }) =>
      chain(() => (order = { col, asc: o?.ascending !== false }));
    builder.limit = (n: number) => chain(() => (limit = n));
    builder.insert = (v: Row | Row[]) =>
      chain(() => {
        op = 'insert';
        values = v;
      });
    builder.update = (v: Row) =>
      chain(() => {
        op = 'update';
        values = v;
      });
    builder.maybeSingle = async () => ({
      data: (run() ?? [])[0] ?? null,
      error: null,
    });
    builder.single = async () => {
      const row = (run() ?? [])[0];
      return row
        ? { data: row, error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    };
    builder.then = (
      ok: (v: unknown) => unknown,
      fail?: (e: unknown) => unknown
    ) => Promise.resolve({ data: run(), error: null }).then(ok, fail);
    return builder;
  };

  const rpc = async (fn: string, params: Row) => {
    rpcCalls.push([fn, params]);
    try {
      return { data: (await opts.rpc?.(fn, params)) ?? null, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        data: null,
        error: { code: err.code, message: String(err.message) },
      };
    }
  };

  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Uint8Array, options?: Row) => {
        try {
          opts.upload?.(bucket, path);
        } catch (e) {
          return {
            data: null,
            error: { message: String((e as { message?: string }).message) },
          };
        }
        uploads.push({ bucket, path, bytes, options });
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path: string, expiresIn: number) => ({
        data: {
          signedUrl: `http://storage.test/${bucket}/${path}?token=t&exp=${expiresIn}`,
        },
        error: null,
      }),
      remove: async (paths: string[]) => {
        removed.push({ bucket, paths });
        return { data: [], error: null };
      },
    }),
  };

  return {
    db: { from, rpc, storage } as never,
    tables,
    log,
    rpcCalls,
    uploads,
    removed,
  };
}
