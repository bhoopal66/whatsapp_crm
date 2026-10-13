import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WRAPUP_MS,
  WRAPUP_OWED_MS,
  pickWrapUps,
  wrapUpCutoff,
  wrapUpLeftMs,
  wrapUpPanel,
  wrapUpPhase,
  type WrapUpRow,
} from '../call-ui';

const NOW = Date.parse('2026-10-13T09:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (over: Partial<WrapUpRow> = {}): WrapUpRow => ({
  connection_id: 'c1',
  pbx_call_id: 'p1',
  direction: 'inbound',
  contact_id: 'k1',
  remote_number: '971500000001',
  answered_at: ago(5 * 60_000),
  ended_at: ago(30_000),
  disposition: null,
  erased_at: null,
  ...over,
});

describe('the wrap-up window', () => {
  it('is two minutes, as 097 waits before reminding, back to its hour', () => {
    expect(WRAPUP_MS).toBe(120_000);
    expect(WRAPUP_OWED_MS).toBe(3_600_000);
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/097_pbx_wrapup.sql'),
      'utf8'
    );
    expect(sql).toMatch(/ended_at <= now\(\) - interval '2 minutes'/);
    expect(sql).toMatch(/ended_at > now\(\) - interval '1 hour'/);
    // Never a call that ended before outcomes were made mandatory.
    expect(sql).toMatch(/c\.ended_at > s\.mandatory_disposition_since/);
  });

  it('counts down from the end of the call, and never past it', () => {
    expect(wrapUpLeftMs(NOW, NOW)).toBe(WRAPUP_MS);
    expect(wrapUpLeftMs(NOW - 45_000, NOW)).toBe(75_000);
    expect(wrapUpLeftMs(NOW - WRAPUP_MS, NOW)).toBe(0);
    expect(wrapUpLeftMs(NOW - 10 * 60_000, NOW)).toBe(0);
    // An end stamped ahead of this clock still gives two minutes, no more.
    expect(wrapUpLeftMs(NOW + 30_000, NOW)).toBe(WRAPUP_MS);
  });

  it('closes by itself when the time is up, unless an outcome is owed', () => {
    const ended = NOW - WRAPUP_MS;
    expect(wrapUpPhase('counting', NOW - 60_000, NOW, false, null)).toBe(
      'counting'
    );
    expect(wrapUpPhase('counting', NOW - 60_000, NOW, true, null)).toBe(
      'counting'
    );
    expect(wrapUpPhase('counting', ended, NOW, false, null)).toBe('done');
    expect(wrapUpPhase('counting', ended, NOW, true, null)).toBe('held');
    expect(wrapUpPhase('counting', ended, NOW, true, 'interested')).toBe(
      'done'
    );
  });

  it('stays held once owed: a late outcome does not snap it shut', () => {
    const ended = NOW - 10 * 60_000;
    expect(wrapUpPhase('held', ended, NOW, true, 'call_back')).toBe('held');
    expect(wrapUpPhase('held', ended, NOW, false, null)).toBe('held');
    expect(wrapUpPhase('done', ended, NOW, true, null)).toBe('done');
  });
});

// Outcomes mandatory since long before any of these calls ended.
const LONG_AGO = NOW - 24 * WRAPUP_OWED_MS;

describe('pickWrapUps', () => {
  it('re-opens my calls still in their wrap-up, newest end first', () => {
    const older = row({ pbx_call_id: 'old', ended_at: ago(90_000) });
    const newer = row({ pbx_call_id: 'new', ended_at: ago(20_000) });
    expect(pickWrapUps([older, newer], NOW, null)).toEqual([newer, older]);
    expect(pickWrapUps([newer, older], NOW, null)).toEqual([newer, older]);
  });

  it('skips a call whose two minutes are up', () => {
    const late = row({ pbx_call_id: 'late', ended_at: ago(WRAPUP_MS) });
    const inTime = row({ pbx_call_id: 'in', ended_at: ago(WRAPUP_MS - 1) });
    expect(pickWrapUps([late], NOW, null)).toEqual([]);
    expect(pickWrapUps([late, inTime], NOW, null)).toEqual([inTime]);
  });

  it('keeps an owed outcome past the two minutes where outcomes are mandatory', () => {
    const owed = row({ pbx_call_id: 'owed', ended_at: ago(10 * 60_000) });
    const stale = row({ pbx_call_id: 'stale', ended_at: ago(WRAPUP_OWED_MS) });
    expect(pickWrapUps([owed], NOW, null)).toEqual([]);
    expect(pickWrapUps([owed, stale], NOW, LONG_AGO)).toEqual([owed]);
    expect(pickWrapUps([stale], NOW, LONG_AGO)).toEqual([]);
  });

  it('owes nothing that ended before outcomes were made mandatory', () => {
    const since = NOW - 5 * 60_000;
    const before = row({ pbx_call_id: 'before', ended_at: ago(5 * 60_000) });
    const after = row({ pbx_call_id: 'after', ended_at: ago(5 * 60_000 - 1) });
    expect(pickWrapUps([before, after], NOW, since)).toEqual([after]);
    // Switched on a moment ago: a call in its two minutes still re-opens.
    const counting = row({ pbx_call_id: 'counting', ended_at: ago(60_000) });
    expect(pickWrapUps([counting, before], NOW, NOW - 1000)).toEqual([
      counting,
    ]);
    expect(wrapUpCutoff(NOW, null)).toBe(NOW - WRAPUP_MS);
    expect(wrapUpCutoff(NOW, NaN)).toBe(NOW - WRAPUP_MS);
    expect(wrapUpCutoff(NOW, NOW)).toBe(NOW - WRAPUP_MS);
    expect(wrapUpCutoff(NOW, since)).toBe(since);
    expect(wrapUpCutoff(NOW, LONG_AGO)).toBe(NOW - WRAPUP_OWED_MS);
  });

  it('skips calls with an outcome, unanswered, internal, erased or still live', () => {
    for (const over of [
      { disposition: 'interested' },
      { answered_at: null },
      { direction: 'internal' },
      { erased_at: ago(1000) },
      { ended_at: null },
      { ended_at: 'not a date' },
      { connection_id: null },
    ] satisfies Partial<WrapUpRow>[]) {
      for (const since of [null, LONG_AGO])
        expect(pickWrapUps([row(over)], NOW, since)).toEqual([]);
    }
    expect(
      pickWrapUps([row({ direction: 'outbound' })], NOW, null)
    ).toHaveLength(1);
    expect(pickWrapUps([], NOW, LONG_AGO)).toEqual([]);
  });
});

describe('wrapUpPanel', () => {
  it('times the recovered wrap-up by the server count, on this clock', () => {
    const p = wrapUpPanel(
      {
        connectionId: 'c1',
        pbxCallId: 'p1',
        direction: 'outbound',
        contactId: null,
        remoteNumber: '971500000001',
        leftMs: 50_000,
      },
      NOW
    );
    expect(p).toMatchObject({
      key: 'c1:p1',
      connectionId: 'c1',
      pbxCallId: 'p1',
      contactId: null,
      inbound: false,
    });
    expect(p.endedAt).not.toBeNull();
    expect(wrapUpLeftMs(p.endedAt!, NOW)).toBe(50_000);
  });

  it('never stretches the window past two minutes', () => {
    const p = wrapUpPanel(
      {
        connectionId: 'c1',
        pbxCallId: 'p1',
        direction: 'inbound',
        contactId: 'k1',
        remoteNumber: null,
        leftMs: 10 * 60_000,
      },
      NOW
    );
    expect(p.inbound).toBe(true);
    expect(wrapUpLeftMs(p.endedAt!, NOW)).toBe(WRAPUP_MS);
  });
});
