import { describe, expect, it, vi } from 'vitest';
import {
  NO_PANEL,
  WRAPUP_MS,
  WRAPUP_OWED_MS,
  closeWrapUp,
  noteOutcome,
  recoverWrapUps,
  selectPanel,
  tryTimes,
  wrapUpPanel,
  type CallLiveRow,
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
