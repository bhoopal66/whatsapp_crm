import { describe, expect, it } from 'vitest';

import {
  NO_PANEL,
  closeWrapUp,
  endsGoneCall,
  isCallGoneCode,
  markCallGone,
  selectPanel,
  type CallLiveRow,
  type CallPulse,
} from '../call-ui';

const ME = 'me';
const T = Date.parse('2026-11-25T10:00:00Z');
const row = (over: Partial<CallLiveRow> = {}): CallLiveRow => ({
  connection_id: 'c1',
  pbx_call_id: 'a',
  account_id: 'acc',
  contact_id: null,
  remote_number: '971500000001',
  did_number: null,
  ringing_user_ids: [],
  answered_by: ME,
  members: [{ kind: 'inbound' }],
  state: 'answered',
  updated_at: '2026-11-25T10:00:00.500+00:00',
  ...over,
});
const pulse = (inCall = false): CallPulse => ({
  quietMs: () => 0,
  inCall: () => inCall,
});
const sel = (s: typeof NO_PANEL, rows: CallLiveRow[], now: number) =>
  selectPanel(s, rows, ME, now, false, pulse());
const gone = (rows = [row()], p = pulse()) =>
  markCallGone(sel(NO_PANEL, [row()], T), row(), rows, ME, T + 1000, false, p);

describe('a call the PBX says this person is not on', () => {
  it('goes to its wrap-up at once, however fresh its row', () => {
    expect(gone().panel).toMatchObject({ pbxCallId: 'a', endedAt: T + 1000 });
    expect(endsGoneCall(row(), [row()], pulse())).toBe(true);
    expect(endsGoneCall(row(), [], pulse())).toBe(true);
  });

  it('stays there when the row is read again, spelled either way', () => {
    const s = sel(gone(), [row()], T + 2000);
    const text = row({ updated_at: '2026-11-25 10:00:00.5+00' });
    expect(sel(s, [text], T + 3000).panel?.endedAt).toBe(T + 1000);
    const closed = closeWrapUp(s, 'c1:a', [row()], ME, T + 4000, false);
    expect(closed.panel).toBeNull();
    expect(sel(closed, [row()], T + 5000).panel).toBeNull();
  });

  it('comes back on a newer frame that names this person', () => {
    const newer = row({ updated_at: '2026-11-25T10:00:05+00:00' });
    const s = sel(gone(), [newer], T + 6000);
    expect(s.panel).toMatchObject({ pbxCallId: 'a', endedAt: null });
    // Its wrap-up does not wait behind the call itself.
    expect(s.waiting).toEqual([]);
    const theirs = { ...newer, answered_by: 'them' };
    expect(sel(gone(), [theirs], T + 6000).panel?.endedAt).toBe(T + 1000);
  });

  it('is not ended over a frame newer than the question', () => {
    const newer = row({ updated_at: '2026-11-25T10:00:05+00:00' });
    expect(endsGoneCall(row(), [newer], pulse())).toBe(false);
    expect(gone([newer]).panel?.endedAt).toBeNull();
  });

  it('is not ended while the softphone in this tab holds it', () => {
    expect(endsGoneCall(row(), [row()], pulse(true))).toBe(false);
    expect(gone([row()], pulse(true)).panel?.endedAt).toBeNull();
  });

  it('is told by the route’s two codes only', () => {
    expect(['not_on_call', 'call_gone'].every(isCallGoneCode)).toBe(true);
    expect(isCallGoneCode('no_extension')).toBe(false);
    expect(isCallGoneCode(undefined)).toBe(false);
  });
});
