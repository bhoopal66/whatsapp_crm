import { beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the three tables the pass reads, with the
// claim table's primary key enforced the way ON CONFLICT DO NOTHING
// does: only rows actually written come back.
const h = vi.hoisted(() => ({
  automations: [] as Record<string, unknown>[],
  conversations: [] as Record<string, unknown>[],
  claims: [] as Record<string, unknown>[],
  run: vi.fn(),
  /** The claim read misses rows (another pass claims after it). */
  hideClaims: false,
}));

vi.mock('./admin-client', () => {
  const key = (r: Record<string, unknown>) =>
    `${r.automation_id}|${r.conversation_id}|${r.occurrence_at}`;
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        const filters: [string, unknown][] = [];
        let rows: Record<string, unknown>[] | null = null;
        const source = () =>
          table === 'automations'
            ? h.automations
            : table === 'conversations'
              ? h.conversations
              : h.claims;
        const result = () => {
          if (!rows && table === 'automation_time_runs' && h.hideClaims) {
            return { data: [], error: null };
          }
          const data = (rows ?? source()).filter((r) =>
            filters.every(([c, v]) => (r[c] ?? null) === v)
          );
          return { data, error: null };
        };
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push([c, v]), b),
          is: (c: string, v: unknown) => (filters.push([c, v]), b),
          order: () => b,
          range: (from: number, to: number) => {
            const r = result();
            return Promise.resolve({
              data: r.data.slice(from, to + 1),
              error: null,
            });
          },
          upsert: (input: Record<string, unknown>[]) => {
            const have = new Set(h.claims.map(key));
            rows = input.filter((r) => !have.has(key(r)));
            h.claims.push(...rows);
            return b;
          },
          then: (resolve: (v: unknown) => void) => resolve(result()),
        };
        return b;
      },
    }),
  };
});

vi.mock('./engine', () => ({ runAutomationForSubject: h.run }));

import { runTimeBasedAutomations } from './time-based-run';

const ok = { opted_out_at: null, do_not_contact_at: null };

beforeEach(() => {
  h.run.mockReset().mockResolvedValue(true);
  h.claims.length = 0;
  h.automations = [
    {
      id: 'a1',
      account_id: 'acc',
      trigger_type: 'time_based',
      is_active: true,
      created_at: '2026-11-01T00:00:00Z',
      trigger_config: { schedule: '0 9 * * *', chat_tag_id: 'tag-1' },
    },
  ];
  h.conversations = [
    {
      id: 'c1',
      contact_id: 'p1',
      account_id: 'acc',
      chat_tag_id: 'tag-1',
      personal_owner_id: null,
      contact: ok,
    },
    {
      id: 'c2',
      contact_id: 'p2',
      account_id: 'acc',
      chat_tag_id: 'tag-1',
      personal_owner_id: null,
      contact: { ...ok, opted_out_at: '2026-01-01' },
    },
    {
      id: 'c3',
      contact_id: 'p3',
      account_id: 'acc',
      chat_tag_id: 'tag-2',
      personal_owner_id: null,
      contact: ok,
    },
    {
      id: 'c4',
      contact_id: 'p4',
      account_id: 'other',
      chat_tag_id: 'tag-1',
      personal_owner_id: null,
      contact: ok,
    },
  ];
});

describe('runTimeBasedAutomations', () => {
  it('starts each due chat at the tag once, and a repeated pass starts nobody', async () => {
    const now = new Date('2026-11-28T05:01:00Z');
    expect(await runTimeBasedAutomations(now)).toEqual({ due: 1, started: 1 });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0][0]).toMatchObject({
      contactId: 'p1',
      conversationId: 'c1',
    });
    expect(h.claims).toEqual([
      expect.objectContaining({
        automation_id: 'a1',
        conversation_id: 'c1',
        occurrence_at: '2026-11-28T05:00:00.000Z',
      }),
    ]);

    expect(
      await runTimeBasedAutomations(new Date('2026-11-28T05:02:00Z'))
    ).toEqual({ due: 1, started: 0 });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('leaves a chat another pass claimed meanwhile to that pass', async () => {
    // The other pass's claim lands after this pass read the claims: the
    // insert writes nothing for it, so nothing starts.
    h.claims.push({
      automation_id: 'a1',
      account_id: 'acc',
      conversation_id: 'c1',
      occurrence_at: '2026-11-28T05:00:00.000Z',
    });
    h.hideClaims = true;
    try {
      expect(
        await runTimeBasedAutomations(new Date('2026-11-28T05:01:00Z'))
      ).toEqual({ due: 1, started: 0 });
    } finally {
      h.hideClaims = false;
    }
    expect(h.run).not.toHaveBeenCalled();
  });

  it('is not due before the time, and the next day is a new occurrence', async () => {
    await runTimeBasedAutomations(new Date('2026-11-28T04:59:00Z'));
    expect(h.run).not.toHaveBeenCalled();
    await runTimeBasedAutomations(new Date('2026-11-28T05:01:00Z'));
    await runTimeBasedAutomations(new Date('2026-11-29T05:01:00Z'));
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('skips an automation saved without a chat tag', async () => {
    h.automations[0].trigger_config = { schedule: '0 9 * * *' };
    expect(
      await runTimeBasedAutomations(new Date('2026-11-28T05:01:00Z'))
    ).toEqual({ due: 0, started: 0 });
    expect(h.run).not.toHaveBeenCalled();
  });
});
