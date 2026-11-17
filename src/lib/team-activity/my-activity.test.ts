import { describe, expect, it } from 'vitest';

import { ruleMessage } from './blocked-send';
import {
  asRestriction,
  blocksByRule,
  isKnownRule,
  myBlocks,
  mySenderRow,
  myUnlocks,
} from './my-activity';
import type { SenderActivity } from './report';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const sender = (over: Partial<SenderActivity>) =>
  ({ kind: 'person', userId: null, ...over }) as SenderActivity;

describe('mySenderRow', () => {
  it("picks the caller's person row out of a team report", () => {
    const mine = sender({ userId: ME, name: 'Me' });
    const report = {
      senders: [
        sender({ userId: OTHER, name: 'Someone else' }),
        sender({ kind: 'api', userId: ME }),
        mine,
      ],
    };
    expect(mySenderRow(report, ME)).toBe(mine);
  });

  it('never takes another person, an API or bot row', () => {
    const report = {
      senders: [
        sender({ userId: OTHER }),
        sender({ kind: 'bot', userId: ME }),
        sender({ kind: 'api', userId: ME }),
      ],
    };
    expect(mySenderRow(report, ME)).toBeNull();
  });

  it('has no row without a signed-in user', () => {
    const report = { senders: [sender({ userId: null })] };
    expect(mySenderRow(report, null)).toBeNull();
    expect(mySenderRow(report, undefined)).toBeNull();
  });
});

describe('myBlocks', () => {
  it("keeps only the caller's blocks, newest first, and drops junk", () => {
    const body = {
      blocks: [
        {
          id: 'a',
          user_id: ME,
          conversation_id: 'c1',
          rule: 'chase',
          detail: { limit: 3 },
          created_at: '2026-11-10T08:00:00Z',
        },
        {
          id: 'b',
          user_id: OTHER,
          rule: 'burst',
          created_at: '2026-11-11T08:00:00Z',
        },
        {
          id: 'c',
          user_id: ME,
          conversation_id: null,
          rule: 'link_first',
          detail: null,
          created_at: '2026-11-12T08:00:00Z',
        },
        { id: 'd', user_id: ME, created_at: '2026-11-12T09:00:00Z' },
        'junk',
      ],
    };
    expect(myBlocks(body, ME)).toEqual([
      {
        id: 'c',
        rule: 'link_first',
        conversationId: null,
        detail: {},
        createdAt: '2026-11-12T08:00:00Z',
      },
      {
        id: 'a',
        rule: 'chase',
        conversationId: 'c1',
        detail: { limit: 3 },
        createdAt: '2026-11-10T08:00:00Z',
      },
    ]);
  });

  it('reads an unexpected body as no blocks', () => {
    expect(myBlocks(null, ME)).toEqual([]);
    expect(myBlocks({ blocks: 'x' }, ME)).toEqual([]);
  });
});

describe('myUnlocks', () => {
  it("keeps only the caller's requests with a known status", () => {
    const body = {
      unlocks: [
        {
          id: 'u1',
          requester_id: ME,
          rule: 'daily_user',
          reason: 'Customer asked me to call back',
          status: 'denied',
          decision_note: 'Wait until tomorrow',
          expires_at: null,
          created_at: '2026-11-10T08:00:00Z',
        },
        {
          id: 'u2',
          requester_id: OTHER,
          rule: 'chase',
          reason: 'x',
          status: 'pending',
          created_at: '2026-11-11T08:00:00Z',
        },
        {
          id: 'u3',
          requester_id: ME,
          rule: 'chase',
          reason: 'Follow up',
          status: 'expired',
          decision_note: '',
          expires_at: '2026-11-12T09:00:00Z',
          created_at: '2026-11-12T08:00:00Z',
        },
        {
          id: 'u4',
          requester_id: ME,
          status: 'weird',
          created_at: '2026-11-12T08:00:00Z',
        },
      ],
    };
    const rows = myUnlocks(body, ME);
    expect(rows.map((r) => r.id)).toEqual(['u3', 'u1']);
    expect(rows[0]).toMatchObject({ status: 'expired', decisionNote: null });
    expect(rows[1]).toMatchObject({
      status: 'denied',
      decisionNote: 'Wait until tomorrow',
      reason: 'Customer asked me to call back',
    });
  });
});

describe('blocksByRule', () => {
  it('counts per rule, most often first, ties by name', () => {
    expect(
      blocksByRule([
        { rule: 'chase' },
        { rule: 'burst' },
        { rule: 'chase' },
        { rule: 'link_first' },
      ])
    ).toEqual([
      { rule: 'chase', count: 2 },
      { rule: 'burst', count: 1 },
      { rule: 'link_first', count: 1 },
    ]);
  });
});

describe('asRestriction', () => {
  it("feeds ruleMessage the block's figures", () => {
    expect(
      ruleMessage(
        asRestriction({ id: 'a', rule: 'chase', detail: { limit: 3 } })
      )
    ).toEqual({ key: 'chase', values: { limit: 3 } });
  });

  it("falls back to the figure-free sentence for an unlock's rule", () => {
    expect(ruleMessage(asRestriction({ id: 'u', rule: 'chase' }))).toEqual({
      key: 'chasePlain',
      values: {},
    });
  });

  it('knows which rules this build can word', () => {
    expect(isKnownRule('burst')).toBe(true);
    expect(isKnownRule('something_new')).toBe(false);
  });
});
