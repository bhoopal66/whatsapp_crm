/**
 * In-memory stand-in for migration 264's functions, for tests. One object
 * per test; hand every `webhook_inbox_*` RPC of the fake client to `rpc`.
 */

interface Row {
  id: string;
  account_id: string;
  channel: string;
  provider: string;
  event_key: string;
  kind: string;
  payload: unknown;
  received_at: string;
  attempts: number;
  state: 'leased' | 'waiting' | 'done' | 'dead';
  last_error: string | null;
}

export class FakeInbox {
  rows: Row[] = [];
  /** Every call in order, `name` without its prefix. */
  calls: { name: string; args: Record<string, unknown> }[] = [];
  /** Error answered by a function, by its name without the prefix. */
  errors: Record<string, { code: string }> = {};
  deadAccounts: { account_id: string; events: number }[] = [];

  /** 264 not applied: PostgREST knows none of the functions. */
  missing(): void {
    for (const fn of ['record', 'settle', 'claim', 'notify_dead', 'purge']) {
      this.errors[fn] = { code: 'PGRST202' };
    }
  }

  add(row: Partial<Row>): Row {
    const full: Row = {
      id: `inbox-${this.rows.length + 1}`,
      account_id: 'acc-1',
      channel: 'cfg-1',
      provider: 'whapi',
      event_key: `key-${this.rows.length + 1}`,
      kind: 'message',
      payload: {},
      received_at: new Date().toISOString(),
      attempts: 1,
      state: 'waiting',
      last_error: null,
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  async rpc(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ data: unknown; error: unknown }> {
    const fn = name.replace('webhook_inbox_', '');
    this.calls.push({ name: fn, args });
    const error = this.errors[fn];
    if (error) return { data: null, error };
    switch (fn) {
      case 'record':
        return { data: this.record(args), error: null };
      case 'settle':
        return { data: this.settle(args), error: null };
      case 'claim':
        return { data: this.claim(Number(args.p_limit ?? 1)), error: null };
      case 'notify_dead':
        return { data: this.deadAccounts, error: null };
      case 'purge':
        return { data: 0, error: null };
      default:
        throw new Error(`unexpected inbox function ${name}`);
    }
  }

  private record(args: Record<string, unknown>) {
    return (args.p_events as Partial<Row>[]).map((e) => {
      const row = this.rows.find(
        (r) =>
          r.provider === e.provider &&
          r.channel === e.channel &&
          r.event_key === e.event_key
      );
      if (!row) return answer(this.add({ ...e, state: 'leased' }), 'new');
      if (row.state === 'done') return answer(row, 'done');
      if (row.state === 'leased') return answer(row, 'busy');
      row.attempts = row.state === 'dead' ? 1 : row.attempts + 1;
      row.state = 'leased';
      return answer(row, 'retaken');
    });
  }

  private settle(args: Record<string, unknown>) {
    const row = this.rows.find((r) => r.id === args.p_id);
    const outcome = args.p_outcome as string;
    if (!row || row.state === 'done') return null;
    row.last_error = (args.p_error as string | null) ?? null;
    if (
      outcome === 'done' ||
      (outcome === 'unmatched' && Number(args.p_attempt) >= 3)
    ) {
      row.state = 'done';
      return 'done';
    }
    if (row.attempts !== args.p_attempt) return null;
    row.state = row.attempts >= 8 ? 'dead' : 'waiting';
    return row.state === 'dead' ? 'dead' : 'retry';
  }

  private claim(limit: number) {
    return this.rows
      .filter((r) => r.state === 'waiting')
      .slice(0, limit)
      .map((r) => {
        r.state = 'leased';
        r.attempts += 1;
        return { ...r, attempt: r.attempts };
      });
  }
}

function answer(row: Row, state: string) {
  return {
    event_key: row.event_key,
    id: row.id,
    attempt: row.attempts,
    state,
  };
}
