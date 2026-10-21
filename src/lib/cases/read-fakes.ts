// Test-only fakes for the case read tests (inbox, timeline, conversations); not imported by app code.
// FakeClient stands in for a supabase-js client: `rpc` answers from a per-function script and every
// `from(table)...` chain records its filters and answers from a per-table handler when awaited. All
// fakes share one ordered `log`, so a test can assert what ran before what.
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CaseStore } from './store';
import type { Case } from './types';

export type Result = {
  data?: unknown;
  error?: { message?: string; code?: string; hint?: string | null } | null;
};
export type Query = {
  table: string;
  columns: string;
  filters: [string, string, unknown][];
  orders: string[];
  limit: number | null;
};
type Args = Record<string, unknown>;

export class FakeClient {
  readonly queries: Query[] = [];
  readonly rpcs: { fn: string; args: Args }[] = [];
  constructor(
    readonly name: string,
    readonly log: string[],
    readonly rpcScript: Record<string, (args: Args) => Result> = {},
    readonly tables: Record<string, (q: Query) => Result> = {}
  ) {}

  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  async rpc(fn: string, args: Args) {
    this.log.push(`${this.name}.rpc:${fn}`);
    this.rpcs.push({ fn, args });
    const s = this.rpcScript[fn];
    if (!s) throw new Error(`unscripted rpc ${fn}`);
    const r = s(args);
    return { data: r.data ?? null, error: r.error ?? null };
  }

  from(table: string) {
    const q: Query = {
      table,
      columns: '',
      filters: [],
      orders: [],
      limit: null,
    };
    const run = async () => {
      this.log.push(`${this.name}.from:${table}`);
      this.queries.push(q);
      const h = this.tables[table];
      if (!h) throw new Error(`unscripted table ${table}`);
      const r = h(q);
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const b = {
      select: (c: string) => ((q.columns = c), b),
      eq: (k: string, v: unknown) => (q.filters.push(['eq', k, v]), b),
      gte: (k: string, v: unknown) => (q.filters.push(['gte', k, v]), b),
      order: (k: string) => (q.orders.push(k), b),
      limit: (n: number) => ((q.limit = n), b),
      maybeSingle: async () => {
        const r = await run();
        return {
          data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          error: r.error,
        };
      },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        run().then(ok, ko),
    };
    return b;
  }

  queriesOf(table: string): Query[] {
    return this.queries.filter((x) => x.table === table);
  }
}

export const CASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const CONTACT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const ACTOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export function aCase(over: Partial<Case> = {}): Case {
  return {
    id: CASE_ID,
    accountId: ACCOUNT_ID,
    groupId: GROUP_ID,
    isLead: false,
    submissionRef: 'SUB-1',
    contactId: CONTACT_ID,
    leadSource: null,
    contactName: 'Customer',
    bankCode: 'ADCB',
    bankName: 'ADCB',
    product: 'loan',
    amount: '1500.00',
    agentId: ACTOR,
    coordinatorId: null,
    stage: 'Submitted',
    priority: 'normal',
    dueAt: null,
    slaState: null,
    openedAt: new Date('2026-10-01T08:00:00Z'),
    closedAt: null,
    outcome: null,
    groupEndedAt: null,
    externalUrl: null,
    externalChangedAt: null,
    ...over,
  };
}

/** A CaseStore stand-in: viewCases answers `readable`, role answers `role`. */
export function fakeStore(
  log: string[],
  opts: {
    readable?: boolean;
    role?: Awaited<ReturnType<CaseStore['role']>>;
    kase?: Case | null;
  } = {}
) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const store: Pick<CaseStore, 'get' | 'role' | 'viewCases'> = {
    get: async (id) => {
      log.push('store.get');
      calls.push({ fn: 'get', args: [id] });
      return opts.kase === undefined ? aCase() : opts.kase;
    },
    role: async (id, user) => {
      log.push('store.role');
      calls.push({ fn: 'role', args: [id, user] });
      return opts.role ?? null;
    },
    viewCases: async (actor, ids) => {
      log.push('store.viewCases');
      calls.push({ fn: 'viewCases', args: [actor, ids] });
      return opts.readable === false ? [] : [...ids];
    },
  };
  return { store, calls };
}

export const groupRow = (status: 'ACTIVE' | 'ENDED', over: Args = {}) => ({
  id: GROUP_ID,
  status,
  created_at: '2026-10-01T08:00:00Z',
  ended_at: status === 'ENDED' ? '2026-10-05T08:00:00Z' : null,
  end_reason: status === 'ENDED' ? 'final_stage' : null,
  ...over,
});

export const messageRow = (id: string, at: string, over: Args = {}) => ({
  id,
  group_id: GROUP_ID,
  direction: 'in',
  sender_user_id: null,
  sender_kind: 'customer',
  type: 'text',
  body: `body ${id}`,
  prefixed_body: null,
  media: null,
  wa_message_id: `wa-${id}`,
  wa_timestamp: null,
  send_status: null,
  post_end: false,
  created_at: at,
  ...over,
});
