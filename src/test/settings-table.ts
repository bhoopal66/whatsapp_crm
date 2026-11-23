/**
 * A one-row settings table behind a supabase-js-shaped client, for the
 * tests of the version check (`updated_at`). Every write stamps a new
 * version, as the tables' triggers do.
 */
type Row = Record<string, unknown> & { updated_at: string };

export function settingsTable(initial: Row | null) {
  const table = { row: initial, writes: [] as Record<string, unknown>[] };
  let version = 100;
  const stamp = (values: Record<string, unknown>) => {
    table.writes.push(values);
    table.row = { ...table.row, ...values, updated_at: `v${version++}` };
    return [table.row];
  };

  function query(run: (filters: [string, unknown][]) => unknown) {
    const filters: [string, unknown][] = [];
    const answer = () => {
      const data = run(filters);
      return data === 'conflict'
        ? { data: null, error: { code: '23505', message: 'duplicate key' } }
        : { data, error: null };
    };
    const q = {
      select: () => q,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return q;
      },
      maybeSingle: async () => {
        const { data, error } = answer();
        return { data: (data as Row[] | null)?.[0] ?? null, error };
      },
      then: (resolve: (v: unknown) => void) => resolve(answer()),
    };
    return q;
  }
  const version_ok = (filters: [string, unknown][]) =>
    filters.every(
      ([column, value]) =>
        column !== 'updated_at' || table.row?.updated_at === value
    );

  const client = {
    from: () => ({
      select: () => query(() => (table.row ? [table.row] : [])),
      insert: (values: Record<string, unknown>) =>
        query(() => (table.row ? 'conflict' : stamp(values))),
      upsert: (values: Record<string, unknown>) => query(() => stamp(values)),
      update: (values: Record<string, unknown>) =>
        query((filters) =>
          table.row && version_ok(filters) ? stamp(values) : []
        ),
    }),
  };
  return { table, client };
}
