import { describe, expect, it } from 'vitest';

import {
  applyDecision,
  blockRuleMessage,
  decisionFailure,
  orderUnlocks,
  parseBlocks,
  parseUnlocks,
  pendingCount,
  sortBlocks,
  summarizeBlocks,
  tabFromParam,
  type TeamBlock,
  type UnlockRequest,
} from './team-blocks';

function block(over: Partial<TeamBlock>): TeamBlock {
  return {
    id: 'b',
    userId: 'u1',
    conversationId: 'c1',
    channelId: 'ch1',
    rule: 'chase',
    source: 'human',
    detail: {},
    createdAt: '2026-11-10T10:00:00Z',
    ...over,
  };
}

function unlock(over: Partial<UnlockRequest>): UnlockRequest {
  return {
    id: 'r',
    blockId: null,
    requesterId: 'u1',
    conversationId: 'c1',
    rule: 'chase',
    reason: 'customer asked',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: null,
    usedAt: null,
    createdAt: '2026-11-10T10:00:00Z',
    ...over,
  };
}

describe('tabFromParam', () => {
  it('opens the named tab, else the overview', () => {
    expect(tabFromParam('unlocks')).toBe('unlocks');
    expect(tabFromParam('blocks')).toBe('blocks');
    expect(tabFromParam('overview')).toBe('overview');
    expect(tabFromParam('nonsense')).toBe('overview');
    expect(tabFromParam(null)).toBe('overview');
  });
});

describe('parseBlocks', () => {
  it('maps the route rows and drops malformed ones', () => {
    const rows = parseBlocks({
      blocks: [
        {
          id: 'b1',
          user_id: null,
          conversation_id: 'c1',
          channel_id: 'ch1',
          rule: 'burst',
          source: 'auto',
          detail: { limit: 5 },
          created_at: '2026-11-10T10:00:00Z',
        },
        { id: 'b2', rule: 'chase' },
        null,
        { id: 'b3', rule: 'chase', created_at: 'x', detail: [1] },
      ],
    });
    expect(rows).toEqual([
      {
        id: 'b1',
        userId: null,
        conversationId: 'c1',
        channelId: 'ch1',
        rule: 'burst',
        source: 'auto',
        detail: { limit: 5 },
        createdAt: '2026-11-10T10:00:00Z',
      },
      expect.objectContaining({ id: 'b3', source: 'human', detail: {} }),
    ]);
    expect(parseBlocks(null)).toEqual([]);
    expect(parseBlocks({ blocks: 'x' })).toEqual([]);
  });
});

describe('parseUnlocks', () => {
  it('keeps only known statuses', () => {
    const rows = parseUnlocks({
      unlocks: [
        {
          id: 'r1',
          block_id: 'b1',
          requester_id: 'u1',
          rule: 'chase',
          reason: 'why',
          status: 'approved',
          decision_note: 'ok',
          created_at: '2026-11-10T10:00:00Z',
        },
        { id: 'r2', status: 'weird', created_at: '2026-11-10T10:00:00Z' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'r1',
      blockId: 'b1',
      status: 'approved',
      decisionNote: 'ok',
      decidedAt: null,
    });
  });
});

describe('blockRuleMessage', () => {
  it('words a known rule with its figures', () => {
    expect(blockRuleMessage('chase', { limit: 3 })).toEqual({
      key: 'chase',
      values: { limit: 3 },
    });
  });
  it('keeps an unknown rule by name', () => {
    expect(blockRuleMessage('new_rule', {})).toEqual({
      key: null,
      text: 'new_rule',
    });
  });
});

describe('summarizeBlocks', () => {
  it('counts by rule and by person, most first', () => {
    const s = summarizeBlocks([
      block({ id: '1', rule: 'chase', userId: 'u1' }),
      block({ id: '2', rule: 'burst', userId: 'u2' }),
      block({ id: '3', rule: 'burst', userId: 'u2' }),
      block({ id: '4', rule: 'quiet_hours', source: 'auto', userId: null }),
      block({ id: '5', rule: 'burst', source: 'auto', userId: 'u1' }),
    ]);
    expect(s.total).toBe(5);
    expect(s.byRule).toEqual([
      { key: 'burst', count: 3 },
      { key: 'chase', count: 1 },
      { key: 'quiet_hours', count: 1 },
    ]);
    expect(s.byPerson).toEqual([
      { key: 'auto', count: 2 },
      { key: 'u2', count: 2 },
      { key: 'u1', count: 1 },
    ]);
  });
  it('is empty for no blocks', () => {
    expect(summarizeBlocks([])).toEqual({ total: 0, byRule: [], byPerson: [] });
  });
});

describe('sortBlocks', () => {
  it('puts the newest first', () => {
    const out = sortBlocks([
      block({ id: 'old', createdAt: '2026-11-01T00:00:00Z' }),
      block({ id: 'new', createdAt: '2026-11-09T00:00:00Z' }),
    ]);
    expect(out.map((b) => b.id)).toEqual(['new', 'old']);
  });
});

describe('orderUnlocks', () => {
  it('lists pending first (oldest on top), then the latest decisions', () => {
    const { pending, decided } = orderUnlocks([
      unlock({ id: 'p2', createdAt: '2026-11-10T12:00:00Z' }),
      unlock({
        id: 'd1',
        status: 'denied',
        decidedAt: '2026-11-10T09:00:00Z',
      }),
      unlock({ id: 'p1', createdAt: '2026-11-10T08:00:00Z' }),
      unlock({
        id: 'd2',
        status: 'used',
        decidedAt: '2026-11-10T11:00:00Z',
      }),
    ]);
    expect(pending.map((u) => u.id)).toEqual(['p1', 'p2']);
    expect(decided.map((u) => u.id)).toEqual(['d2', 'd1']);
  });
  it('caps the decided list', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      unlock({ id: `d${i}`, status: 'denied' })
    );
    expect(orderUnlocks(many).decided).toHaveLength(30);
  });
});

describe('pendingCount / applyDecision', () => {
  const list = [
    unlock({ id: 'a' }),
    unlock({ id: 'b' }),
    unlock({ id: 'c', status: 'denied' }),
  ];
  it('counts pending requests', () => {
    expect(pendingCount(list)).toBe(2);
  });
  it('decides one pending request and leaves the rest', () => {
    const out = applyDecision(list, 'a', true, 'go', '2026-11-11T00:00:00Z');
    expect(out[0]).toMatchObject({
      status: 'approved',
      decidedAt: '2026-11-11T00:00:00Z',
      decisionNote: 'go',
    });
    expect(out[1]).toBe(list[1]);
    expect(pendingCount(out)).toBe(1);
    expect(applyDecision(list, 'b', false, null, 't')[1].status).toBe('denied');
  });
  it('never re-decides a decided request', () => {
    expect(applyDecision(list, 'c', true, null, 't')[2]).toBe(list[2]);
  });
});

describe('decisionFailure', () => {
  it('names the refusals', () => {
    expect(decisionFailure(409)).toBe('conflict');
    expect(decisionFailure(403)).toBe('forbidden');
    expect(decisionFailure(404)).toBe('notFound');
    expect(decisionFailure(500)).toBe('failed');
  });
});
