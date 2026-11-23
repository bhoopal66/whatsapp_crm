import { describe, expect, it, vi } from 'vitest';
import {
  CLOSABLE_QUIET_MS,
  NO_PANEL,
  PANEL_QUIET_MS,
  WRAPUP_MS,
  WRAPUP_OWED_MS,
  closableKeys,
  closeWrapUp,
  myActiveCall,
  noteOutcome,
  recoverWrapUps,
  selectPanel,
  tryTimes,
  wrapUpPanel,
  type CallLiveRow,
  type CallPulse,
  type PanelState,
} from '../call-ui';

const ME = 'me';
const T = Date.parse('2026-10-13T09:00:00Z');
const live = (id: string, over: Partial<CallLiveRow> = {}): CallLiveRow => ({
  connection_id: 'c1',
  pbx_call_id: id,
  account_id: 'acc',
  contact_id: null,
  remote_number: '971500000001',
  did_number: null,
  ringing_user_ids: [],
  answered_by: ME,
  members: [{ kind: 'inbound' }],
  state: 'talking',
  updated_at: new Date(T).toISOString(),
  ...over,
});
/** A wrap-up a reload recovered, `leftMs` of its two minutes left. */
const recovered = (id: string, leftMs: number, now: number) =>
  wrapUpPanel(
    {
      connectionId: 'c1',
      pbxCallId: id,
      direction: 'inbound',
      contactId: null,
      remoteNumber: null,
      leftMs,
    },
    now
  );
const shown = (s: PanelState) => ({
  panel:
    s.panel && `${s.panel.pbxCallId}:${s.panel.endedAt ? 'ended' : 'live'}`,
  waiting: s.waiting.map((w) => w.pbxCallId),
});
const sel = (s: PanelState, rows: CallLiveRow[], now: number, m = false) =>
  selectPanel(s, rows, ME, now, m);
const close = (
  s: PanelState,
  id: string,
  rows: CallLiveRow[],
  now: number,
  m = false
) => closeWrapUp(s, `c1:${id}`, rows, ME, now, m);

describe('selectPanel: a live call always has the panel', () => {
  it('takes it from a wrap-up a reload recovered first, which then waits', () => {
    for (const mandatory of [false, true]) {
      // The wrap-up answer lands before the first call_live load.
      let s = recoverWrapUps(NO_PANEL, [recovered('a', 0, T)], [], ME, T, true);
      if (!mandatory)
        s = recoverWrapUps(
          NO_PANEL,
          [recovered('a', 60_000, T)],
          [],
          ME,
          T,
          false
        );
      expect(shown(s)).toEqual({ panel: 'a:ended', waiting: [] });
      s = sel(s, [live('b')], T + 500, mandatory);
      expect(shown(s)).toEqual({ panel: 'b:live', waiting: ['a'] });
    }
  });

  it('keeps it when the recovered wrap-up lands after the live load', () => {
    let s = sel(NO_PANEL, [live('b')], T, true);
    s = recoverWrapUps(
      s,
      [recovered('a', 0, T)],
      [live('b')],
      ME,
      T + 500,
      true
    );
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: ['a'] });
  });

  it('re-opens the waiting wrap-up once the live call is over and wrapped up', () => {
    let s = recoverWrapUps(NO_PANEL, [recovered('a', 0, T)], [], ME, T, true);
    s = sel(s, [live('b')], T + 500, true);
    s = sel(s, [], T + 60_000, true);
    expect(shown(s)).toEqual({ panel: 'b:ended', waiting: ['a'] });
    s = close(s, 'b', [], T + 90_000, true);
    expect(shown(s)).toEqual({ panel: 'a:ended', waiting: [] });
  });

  it('is never closed, even by a wrap-up close that lands late', () => {
    let s = sel(NO_PANEL, [live('a')], T);
    s = sel(s, [], T + 1000);
    s = sel(s, [live('b')], T + 2000);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: ['a'] });
    // a's auto-close was still saving when b took the panel.
    s = close(s, 'a', [live('b')], T + 3000);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: [] });
    s = close(s, 'b', [live('b')], T + 4000);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: [] });
  });

  it('follows its own call to the wrap-up, and its contact while live', () => {
    let s = sel(NO_PANEL, [live('a')], T);
    s = sel(s, [live('a', { contact_id: 'k1' })], T + 1000);
    expect(s.panel).toMatchObject({
      contactId: 'k1',
      endedAt: null,
      seenAt: T,
    });
    // Another person's call or a ringing one never takes it.
    s = sel(
      s,
      [live('a', { contact_id: 'k1' }), live('x', { answered_by: 'other' })],
      T + 2000
    );
    expect(shown(s)).toEqual({ panel: 'a:live', waiting: [] });
    s = sel(s, [live('x', { answered_by: 'other' })], T + 3000);
    expect(shown(s)).toEqual({ panel: 'a:ended', waiting: [] });
    expect(s.panel?.endedAt).toBe(T + 3000);
  });
});

describe('selectPanel: a call whose hang-up may be lost', () => {
  const MIN = 60_000;
  const iso = (at: number) => new Date(at).toISOString();
  /** Quiet times read off the rows at `now`; `phone`: in the softphone. */
  const pulse = (now: number, phone: string[] = []): CallPulse => ({
    quietMs: (r) => now - Date.parse(r.updated_at),
    inCall: (r) => phone.includes(r.pbx_call_id),
  });
  const at = (
    s: PanelState,
    rows: CallLiveRow[],
    now: number,
    phone: string[] = [],
    mandatory = false
  ) => selectPanel(s, rows, ME, now, mandatory, pulse(now, phone));
  const closeAt = (
    s: PanelState,
    id: string,
    rows: CallLiveRow[],
    now: number,
    phone: string[] = []
  ) => closeWrapUp(s, `c1:${id}`, rows, ME, now, false, pulse(now, phone));
  const old = live('old');

  it('takes the newest call, a quiet one only when there is no other', () => {
    const now = T + 20 * MIN;
    const b = live('b', { updated_at: iso(now - MIN) });
    const c = live('c', { updated_at: iso(now) });
    const id = (rows: CallLiveRow[], phone: string[] = []) =>
      myActiveCall(rows, ME, pulse(now, phone))?.pbx_call_id;
    expect(id([old, b, c])).toBe('c');
    expect(myActiveCall([old, b, c], ME)?.pbx_call_id).toBe('c');
    expect(id([old])).toBe('old');
    // A quiet call in the softphone beats a later quiet one that is not.
    const ghost = live('g', { updated_at: iso(T + MIN) });
    expect(id([old, ghost])).toBe('g');
    expect(id([old, ghost], ['old'])).toBe('old');
  });

  it('yields the panel to a fresh call after 10 quiet minutes, not before', () => {
    const first = at(NO_PANEL, [old], T);
    for (const [quiet, phone, panel] of [
      [PANEL_QUIET_MS - 1, [], 'old:live'],
      [PANEL_QUIET_MS, [], 'b:live'],
      [5 * PANEL_QUIET_MS, [], 'b:live'],
      [5 * PANEL_QUIET_MS, ['old'], 'old:live'],
    ] as const) {
      const now = T + quiet;
      const rows = [old, live('b', { updated_at: iso(now) })];
      const s = at(first, rows, now, [...phone]);
      expect(shown(s)).toEqual({ panel, waiting: [] });
    }
  });

  it('keeps a real long call on screen when nothing else is live', () => {
    const s = at(NO_PANEL, [old], T);
    expect(at(s, [old], T + 110 * MIN)).toBe(s);
    // Nor does a call as quiet as it take the panel, or a wrap-up.
    const g = live('g', { updated_at: iso(T + MIN) });
    expect(at(s, [old, g], T + 110 * MIN)).toBe(s);
    const r = recoverWrapUps(
      s,
      [recovered('a', 60_000, T + 110 * MIN)],
      [old],
      ME,
      T + 110 * MIN,
      false,
      pulse(T + 110 * MIN)
    );
    expect(shown(r)).toEqual({ panel: 'old:live', waiting: ['a'] });
    // Without a pulse nothing is ever quiet.
    expect(sel(s, [old, live('b')], T + 110 * MIN)).toBe(s);
  });

  it('gives the panel back after the fresh call and its wrap-up', () => {
    const now = T + 20 * MIN;
    const b = live('b', { updated_at: iso(now) });
    let s = at(at(NO_PANEL, [old], T), [old, b], now);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: [] });
    // b ends: its wrap-up, which the quiet call does not push aside.
    s = at(s, [old], now + MIN);
    expect(shown(s)).toEqual({ panel: 'b:ended', waiting: [] });
    s = closeAt(s, 'b', [old], now + 2 * MIN);
    expect(shown(s)).toEqual({ panel: 'old:live', waiting: [] });
    // A frame makes it fresh, and it takes the panel from a wrap-up.
    let f = at(at(NO_PANEL, [old], T), [old, b], now);
    f = at(f, [live('old', { updated_at: iso(now + MIN) })], now + MIN);
    expect(shown(f)).toEqual({ panel: 'old:live', waiting: ['b'] });
  });

  it('takes an empty panel only when no wrap-up is waiting', () => {
    const now = T + 20 * MIN;
    const s = { panel: null, waiting: [recovered('a', 60_000, now)] };
    expect(shown(at(s, [old], now))).toEqual({
      panel: 'a:ended',
      waiting: [],
    });
    expect(shown(at(NO_PANEL, [old], now)).panel).toBe('old:live');
    expect(shown(at(s, [old], now, ['old']))).toEqual({
      panel: 'old:live',
      waiting: ['a'],
    });
  });

  it('is closed by hand only after 30 quiet minutes without a session', () => {
    const s = at(NO_PANEL, [old], T);
    const soon = T + CLOSABLE_QUIET_MS - 1;
    const late = T + CLOSABLE_QUIET_MS;
    expect(closableKeys([old], ME, pulse(soon))).toEqual([]);
    expect(closableKeys([old], ME, pulse(late, ['old']))).toEqual([]);
    expect(closableKeys([old], 'other', pulse(late))).toEqual([]);
    expect(closableKeys([old], ME, pulse(late))).toEqual(['c1:old']);
    expect(closeAt(s, 'old', [old], soon)).toEqual(s);
    expect(closeAt(s, 'old', [old], late, ['old'])).toEqual(s);
    expect(close(s, 'old', [old], late)).toEqual(s);
    expect(closeAt(s, 'old', [old], late).panel).toBeNull();
  });

  it('stays closed until its next frame, through other calls', () => {
    const now = T + 40 * MIN;
    let s = closeAt(at(NO_PANEL, [old], T), 'old', [old], now);
    s = at(s, [old], now + MIN);
    expect(s.panel).toBeNull();
    const b = live('b', { updated_at: iso(now + MIN) });
    s = at(s, [old, b], now + MIN);
    s = recoverWrapUps(s, [], [old, b], ME, now, false, pulse(now + MIN));
    s = at(s, [old], now + 2 * MIN);
    s = closeAt(s, 'b', [old], now + 3 * MIN);
    expect(s.panel).toBeNull();
    s = at(s, [live('old', { updated_at: iso(now + 4 * MIN) })], now + 4 * MIN);
    expect(shown(s)).toEqual({ panel: 'old:live', waiting: [] });
  });
});

describe('selectPanel: back-to-back calls each get their wrap-up', () => {
  it('queues the earlier wrap-up behind the next call, newest end first', () => {
    let s = sel(NO_PANEL, [live('a')], T);
    s = sel(s, [], T + 10_000); // a ends: its wrap-up
    s = sel(s, [live('b')], T + 20_000); // b answered before a's closed
    s = sel(s, [], T + 30_000); // b ends
    s = sel(s, [live('c')], T + 40_000); // c answered before b's closed
    s = sel(s, [], T + 50_000); // c ends
    expect(shown(s)).toEqual({ panel: 'c:ended', waiting: ['b', 'a'] });
    s = close(s, 'c', [], T + 60_000);
    expect(shown(s)).toEqual({ panel: 'b:ended', waiting: ['a'] });
    s = close(s, 'b', [], T + 70_000);
    expect(shown(s)).toEqual({ panel: 'a:ended', waiting: [] });
    s = close(s, 'a', [], T + 80_000);
    expect(s).toEqual(NO_PANEL);
  });

  it('drops a waiting wrap-up whose two minutes ran out with nothing owed, for good', () => {
    let s = sel(NO_PANEL, [live('a')], T);
    s = sel(s, [], T + 1000);
    s = sel(s, [live('b')], T + 2000);
    s = sel(s, [live('b')], T + 1000 + WRAPUP_MS); // the poll during b
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: [] });
    // Making outcomes mandatory afterwards does not bring it back.
    s = sel(s, [], T + 1000 + WRAPUP_MS + 4000, true);
    s = close(s, 'b', [], T + 1000 + WRAPUP_MS + 5000, true);
    expect(s).toEqual(NO_PANEL);
  });

  it('keeps an owed one past its two minutes, until an outcome or the hour', () => {
    let s = sel(NO_PANEL, [live('a')], T, true);
    s = sel(s, [], T + 1000, true);
    s = sel(s, [live('b')], T + 2000, true);
    s = sel(s, [live('b')], T + 1000 + WRAPUP_MS, true);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: ['a'] });
    s = sel(s, [live('b')], T + 1000 + WRAPUP_OWED_MS, true);
    expect(shown(s)).toEqual({ panel: 'b:live', waiting: [] });

    // An outcome chosen before b took the panel: nothing is owed.
    let o = sel(NO_PANEL, [live('a')], T, true);
    o = sel(o, [], T + 1000, true);
    o = noteOutcome(o, 'c1:a', true);
    o = sel(o, [live('b')], T + 2000, true);
    expect(shown(o)).toEqual({ panel: 'b:live', waiting: ['a'] });
    o = sel(o, [live('b')], T + 1000 + WRAPUP_MS, true);
    expect(shown(o)).toEqual({ panel: 'b:live', waiting: [] });
  });

  it('ignores a recovered wrap-up it already holds, and leaves state alone when nothing moves', () => {
    let s = sel(NO_PANEL, [live('a')], T);
    s = sel(s, [], T + 1000);
    const again = recoverWrapUps(
      s,
      [recovered('a', 30_000, T)],
      [],
      ME,
      T + 2000,
      false
    );
    expect(shown(again)).toEqual({ panel: 'a:ended', waiting: [] });
    expect(sel(again, [], T + 3000)).toBe(again);
    expect(noteOutcome(again, 'c1:other', true)).toBe(again);
  });
});

describe('tryTimes', () => {
  it('retries a failed share before giving up', async () => {
    const sleep = vi.fn(async () => undefined);
    const flaky = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(undefined);
    expect(await tryTimes(3, flaky, 2000, sleep)).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);

    const down = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await tryTimes(3, down, 10, sleep)).toBe(false);
    expect(down).toHaveBeenCalledTimes(3);
    expect(await tryTimes(1, down, 10, sleep)).toBe(false);
    expect(down).toHaveBeenCalledTimes(4);
  });
});
