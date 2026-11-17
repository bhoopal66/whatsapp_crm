import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RESTRICTION_RULES,
  cardFor,
  findUnlockRow,
  parseSendRestriction,
  reasonValid,
  ruleMessage,
  unlockCardReducer,
  type SendRestriction,
  type UnlockCardState,
} from './blocked-send';

const body = (over: Record<string, unknown> = {}) => ({
  error: 'Blocked.',
  code: 'restricted',
  rule: 'daily_user',
  blockId: 'b1',
  unlockable: true,
  detail: { started: 20, limit: 20 },
  ...over,
});

const restriction = (
  rule: string,
  detail: Record<string, unknown>
): SendRestriction =>
  parseSendRestriction(429, body({ rule, detail })) as SendRestriction;

describe('parseSendRestriction', () => {
  it('reads a 429 restricted answer', () => {
    expect(parseSendRestriction(429, body())).toEqual({
      rule: 'daily_user',
      blockId: 'b1',
      unlockable: true,
      detail: { started: 20, limit: 20 },
      error: 'Blocked.',
    });
  });

  it('is null for every other failure', () => {
    expect(parseSendRestriction(400, body())).toBeNull();
    expect(
      parseSendRestriction(429, body({ code: 'new_chat_limit' }))
    ).toBeNull();
    expect(parseSendRestriction(429, body({ blockId: undefined }))).toBeNull();
    expect(parseSendRestriction(429, null)).toBeNull();
    expect(parseSendRestriction(429, 'rate limited')).toBeNull();
  });

  it('is not unlockable unless the server says so, and tolerates no detail', () => {
    const r = parseSendRestriction(
      429,
      body({ unlockable: 'yes', detail: [1] })
    );
    expect(r?.unlockable).toBe(false);
    expect(r?.detail).toEqual({});
  });
});

describe('ruleMessage', () => {
  it('names every rule with its figures', () => {
    expect(ruleMessage(restriction('chase', { steps: 4, limit: 3 }))).toEqual({
      key: 'chase',
      values: { limit: 3 },
    });
    expect(
      ruleMessage(
        restriction('quiet_hours', { start: 22, end: 8, tz: 'Asia/Dubai' })
      )
    ).toEqual({ key: 'quietHours', values: { end: '08:00' } });
    expect(
      ruleMessage(restriction('daily_user', { started: 20, limit: 20 }))
    ).toEqual({ key: 'dailyUser', values: { limit: 20 } });
    expect(
      ruleMessage(
        restriction('daily_user_throttled', {
          started: 10,
          limit: 10,
          reply_rate: 12.4,
        })
      )
    ).toEqual({ key: 'dailyUserThrottled', values: { limit: 10, rate: 12 } });
    expect(
      ruleMessage(
        restriction('daily_number', {
          started: 10,
          limit: 10,
          warming_up: true,
        })
      )
    ).toEqual({ key: 'dailyNumberWarmingUp', values: { limit: 10 } });
    expect(
      ruleMessage(
        restriction('burst', { started: 5, limit: 5, retry_after_s: 61 })
      )
    ).toEqual({ key: 'burst', values: { limit: 5, minutes: 2 } });
    expect(ruleMessage(restriction('link_first', {}))).toEqual({
      key: 'linkFirst',
      values: {},
    });
    expect(
      ruleMessage(restriction('same_opener', { count: 3, limit: 3 }))
    ).toEqual({ key: 'sameOpener', values: { count: 3 } });
    expect(ruleMessage(restriction('jev_cold_pitch', { p: 0.9 }))).toEqual({
      key: 'jevColdPitch',
      values: {},
    });
  });

  it('falls back to a figure-free sentence when figures are missing', () => {
    for (const rule of RESTRICTION_RULES) {
      const m = ruleMessage(restriction(rule, {}));
      expect(m.key).not.toBeNull();
      if (m.key) {
        for (const v of Object.values(m.values)) expect(v).toBeDefined();
      }
    }
    expect(ruleMessage(restriction('quiet_hours', {})).key).toBe(
      'quietHoursPlain'
    );
  });

  it("uses the route's words for a rule this build does not know", () => {
    expect(
      ruleMessage(
        parseSendRestriction(
          429,
          body({ rule: 'future_rule', error: 'Not now.' })
        )!
      )
    ).toEqual({ key: null, text: 'Not now.' });
  });

  it('has an English sentence for every key it can return', () => {
    const en = JSON.parse(
      readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
    );
    const words = en.TeamActivity.blocked.rule as Record<string, string>;
    const keys = new Set<string>();
    for (const rule of RESTRICTION_RULES) {
      for (const detail of [
        {},
        {
          limit: 3,
          end: 8,
          reply_rate: 10,
          count: 3,
          retry_after_s: 60,
          warming_up: true,
        },
        { limit: 3 },
      ]) {
        const m = ruleMessage(restriction(rule, detail));
        if (m.key) keys.add(m.key);
      }
    }
    for (const k of keys) expect(words[k], k).toBeTypeOf('string');
  });
});

describe('unlockCardReducer', () => {
  const blocked: UnlockCardState = { phase: 'blocked' };

  it('asks, waits and opens on approval', () => {
    let s = unlockCardReducer(blocked, { type: 'ask' });
    s = unlockCardReducer(s, { type: 'edit', reason: 'abc' });
    // Too short: not sent.
    expect(unlockCardReducer(s, { type: 'submit' })).toBe(s);
    s = unlockCardReducer(s, { type: 'edit', reason: 'Customer asked me' });
    s = unlockCardReducer(s, { type: 'submit' });
    expect(s).toEqual({ phase: 'submitting', reason: 'Customer asked me' });
    s = unlockCardReducer(s, { type: 'submitted', requestId: 'u1' });
    expect(s).toEqual({ phase: 'waiting', requestId: 'u1' });
    // Another request's decision changes nothing.
    const row = { status: 'approved' as const, expiresAt: 'x', note: null };
    expect(
      unlockCardReducer(s, { type: 'decided', row: { ...row, id: 'u2' } })
    ).toBe(s);
    expect(
      unlockCardReducer(s, { type: 'decided', row: { ...row, id: 'u1' } })
    ).toEqual({ phase: 'approved', expiresAt: 'x' });
  });

  it('keeps the reason when the request fails, and reports a denial', () => {
    let s = unlockCardReducer(
      { phase: 'submitting', reason: 'hello there' },
      { type: 'submitFailed' }
    );
    expect(s).toEqual({ phase: 'asking', reason: 'hello there' });
    s = unlockCardReducer(
      { phase: 'waiting', requestId: 'u1' },
      {
        type: 'decided',
        row: { id: 'u1', status: 'denied', expiresAt: null, note: 'No' },
      }
    );
    expect(s).toEqual({ phase: 'denied', note: 'No' });
    expect(
      unlockCardReducer(
        { phase: 'waiting', requestId: 'u1' },
        {
          type: 'decided',
          row: { id: 'u1', status: 'pending', expiresAt: null, note: null },
        }
      )
    ).toEqual({ phase: 'waiting', requestId: 'u1' });
  });

  it('caps the reason at 500 characters and refuses a blank one', () => {
    const s = unlockCardReducer(
      { phase: 'asking', reason: '' },
      { type: 'edit', reason: 'x'.repeat(600) }
    );
    expect(s).toEqual({ phase: 'asking', reason: 'x'.repeat(500) });
    expect(reasonValid('     \n\t ')).toBe(false);
    expect(reasonValid(' abcd ')).toBe(false);
    expect(reasonValid('abcde')).toBe(true);
  });
});

describe('findUnlockRow', () => {
  it('finds the request in a list or a wrapped list', () => {
    const row = {
      id: 'u1',
      status: 'approved',
      expires_at: '2026-11-17T12:00:00Z',
      decision_note: null,
    };
    expect(findUnlockRow({ unlocks: [row] }, 'u1')).toEqual({
      id: 'u1',
      status: 'approved',
      expiresAt: '2026-11-17T12:00:00Z',
      note: null,
    });
    expect(findUnlockRow([row], 'u1')?.status).toBe('approved');
    expect(findUnlockRow([row], 'u2')).toBeNull();
    expect(
      findUnlockRow({ unlocks: [{ id: 'u1', status: 'odd' }] }, 'u1')
    ).toBe(null);
    expect(findUnlockRow(null, 'u1')).toBeNull();
  });
});

describe('cardFor', () => {
  it("never shows another chat's card", () => {
    const r = restriction('link_first', {});
    const cards = {
      c1: { restriction: r, state: { phase: 'blocked' as const } },
    };
    expect(cardFor(cards, 'c1')?.restriction).toBe(r);
    expect(cardFor(cards, 'c2')).toBeNull();
    expect(cardFor(cards, null)).toBeNull();
  });
});
