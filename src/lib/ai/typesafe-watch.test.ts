import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionLayer } from '@/lib/typesafe';
import {
  SWITCHES_UNMANAGED,
  type AccountSwitches,
  type Ts013Config,
} from '@/lib/typesafe/config';
import {
  TEST_ACCOUNT,
  approvedDb,
  makeSim,
  testConfig,
} from '@/lib/typesafe/test-helpers';

// The watch on conversations the bot did not answer: the real decision
// layer over a simulated TypeSafe, with the database and the opt-out write
// stubbed at the module boundary.
const h = vi.hoisted(() => ({
  layer: null as DecisionLayer | null,
  seen: { data: [] as unknown[], error: null as { message: string } | null },
  marked: [] as unknown[],
  context: [] as { role: 'user' | 'assistant'; content: string }[],
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      limit: () => Promise.resolve(h.seen),
    };
    return chain;
  },
}));
vi.mock('./context', () => ({
  buildConversationContext: async () => h.context,
}));
vi.mock('./opt-out', () => ({
  markOptedOut: async (_db: unknown, args: unknown) => {
    h.marked.push(args);
    return true;
  },
}));
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () => h.layer,
}));

import { createDecisionLayer } from '@/lib/typesafe';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { watchInboundMessage } from './typesafe-watch';

function useLayer(opts: {
  sim: ReturnType<typeof makeSim>;
  switches?: Partial<AccountSwitches> | null;
  config?: Partial<Ts013Config>;
}) {
  const db = approvedDb();
  h.layer = createDecisionLayer({
    config: testConfig(opts.config),
    apiKey: 'test-key',
    fetch: opts.sim.fetch,
    alert: () => {},
    store: {
      ...db.store,
      accountSwitches: async () =>
        opts.switches === null
          ? null
          : { ...SWITCHES_UNMANAGED, ...opts.switches },
    },
  });
  return db;
}

const watch = (text = 'please stop sending me messages') =>
  watchInboundMessage({
    accountId: TEST_ACCOUNT,
    conversationId: 'conv-1',
    contactId: '00000000-0000-4000-8000-00000000c001',
    messageId: 'wamid.1',
    text,
    configOwnerUserId: 'owner-1',
  });

beforeEach(() => {
  __resetRateLimitForTests();
  h.layer = null;
  h.seen = { data: [], error: null };
  h.marked = [];
  h.context = [
    { role: 'assistant', content: 'Your statement is ready.' },
    { role: 'user', content: 'please stop sending me messages' },
  ];
});

describe('watchInboundMessage', () => {
  it('marks an opt-out written in a conversation people handle', async () => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.97 } }));
    const db = useLayer({ sim });
    await watch();
    expect(sim.calls).toHaveLength(1);
    expect(h.marked).toEqual([
      {
        accountId: TEST_ACCOUNT,
        contactId: '00000000-0000-4000-8000-00000000c001',
      },
    ]);
    expect(db.inserts[0]).toMatchObject({
      check_name: 'triage',
      decision: 'opted_out',
      acted: true,
    });
    expect(db.inserts[0]!.reason_codes).toContain('WATCH');
  });

  it('logs, but does not act on, a request for a person or a complaint', async () => {
    const sim = makeSim(() => ({ answers: { wants_human: 0.99 } }));
    const db = useLayer({ sim });
    await watch('can I talk to someone');
    expect(h.marked).toEqual([]);
    expect(db.inserts[0]).toMatchObject({ decision: 'rm', acted: false });
  });

  it('only logs in monitor mode', async () => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.97 } }));
    const db = useLayer({ sim, switches: { mode: 'monitor' } });
    await watch();
    expect(h.marked).toEqual([]);
    expect(db.inserts[0]).toMatchObject({ acted: false, shadow: true });
  });

  it.each([
    ['the account never switched the layer on', null],
    ['the account switched the watch off', { watchHumanThreads: false }],
    [
      'the account switched triage off',
      {
        checks: {
          triage: false,
          guardrail: true,
          passages: true,
          eligibility: false,
        },
      },
    ],
  ])('does nothing when %s', async (_label, switches) => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.97 } }));
    const db = useLayer({ sim, switches });
    await watch();
    expect(sim.calls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
    expect(h.marked).toEqual([]);
  });

  it('skips a message the bot’s own triage already judged', async () => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.97 } }));
    const db = useLayer({ sim });
    h.seen = { data: [{ id: 'd1' }], error: null };
    await watch();
    expect(sim.calls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('never throws — a read error or an empty text is a no-op', async () => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.97 } }));
    useLayer({ sim });
    await expect(watch('   ')).resolves.toBeUndefined();
    h.seen = { data: [], error: { message: 'db down' } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(watch()).resolves.toBeUndefined();
    expect(sim.calls).toHaveLength(0);
    err.mockRestore();
  });

  it('stops at the per-account budget, so a burst cannot starve the bot', async () => {
    const sim = makeSim(() => ({ answers: { opt_out: 0.01 } }));
    useLayer({ sim });
    for (let i = 0; i < 61; i++) await watch(`hello ${i}`);
    expect(sim.calls).toHaveLength(60);
  });

  it('is a no-op without a layer', async () => {
    await expect(watch()).resolves.toBeUndefined();
    expect(h.marked).toEqual([]);
  });
});
