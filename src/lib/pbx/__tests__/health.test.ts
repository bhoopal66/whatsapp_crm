import { describe, expect, it } from 'vitest';

import { PBX_SILENCE_MINUTES } from '../admin-ui';
import { checkPbxSilence, silenceAction } from '../health';
import { createFakeDb } from './fake-db';

// Dubai is UTC+4 all year: 09:00 there is 05:00Z, 20:00 is 16:00Z.
const at = (iso: string) => Date.parse(iso);
const minus = (iso: string, minutes: number) =>
  new Date(at(iso) - minutes * 60_000).toISOString();

describe('silenceAction', () => {
  const ten = '2026-10-12T06:00:00Z'; // 10:00 in Dubai

  it('never alerts a connection that never had an event', () => {
    for (const lastEventAt of [null, '', 'not a date']) {
      expect(
        silenceAction({ lastEventAt, silenceAlertedAt: null }, at(ten))
      ).toBeNull();
      expect(
        silenceAction({ lastEventAt, silenceAlertedAt: minus(ten, 5) }, at(ten))
      ).toBeNull();
    }
  });

  it('alerts once the latest event is the threshold old, in working hours', () => {
    const state = (m: number) => ({
      lastEventAt: minus(ten, m),
      silenceAlertedAt: null,
    });
    expect(PBX_SILENCE_MINUTES).toBe(15);
    expect(silenceAction(state(14), at(ten))).toBeNull();
    expect(silenceAction(state(15), at(ten))).toBe('alert');
    expect(silenceAction(state(600), at(ten))).toBe('alert');
    expect(silenceAction(state(3), at(ten), 2)).toBe('alert');
  });

  it('stays quiet outside 09:00-20:00 Dubai, and in the first minutes after opening', () => {
    const evening = '2026-10-11T15:50:00Z'; // 19:50 the day before
    const quiet = (now: string) =>
      silenceAction({ lastEventAt: evening, silenceAlertedAt: null }, at(now));
    expect(quiet('2026-10-11T17:00:00Z')).toBeNull(); // 21:00
    expect(quiet('2026-10-12T01:00:00Z')).toBeNull(); // 05:00
    expect(quiet('2026-10-12T05:00:00Z')).toBeNull(); // 09:00
    expect(quiet('2026-10-12T05:14:00Z')).toBeNull(); // 09:14
    expect(quiet('2026-10-12T05:15:00Z')).toBe('alert'); // 09:15
    expect(quiet('2026-10-12T15:59:00Z')).toBe('alert'); // 19:59
    expect(quiet('2026-10-12T16:00:00Z')).toBeNull(); // 20:00
  });

  it('does not alert again while an alert is out', () => {
    expect(
      silenceAction(
        { lastEventAt: minus(ten, 60), silenceAlertedAt: minus(ten, 40) },
        at(ten)
      )
    ).toBeNull();
    // An event stamped at the alert itself is not one after it.
    expect(
      silenceAction(
        { lastEventAt: minus(ten, 40), silenceAlertedAt: minus(ten, 40) },
        at(ten)
      )
    ).toBeNull();
  });

  it('restores once an event arrived after the alert, at any hour', () => {
    const night = '2026-10-12T19:00:00Z'; // 23:00
    expect(
      silenceAction(
        { lastEventAt: minus(night, 1), silenceAlertedAt: minus(night, 300) },
        at(night)
      )
    ).toBe('restore');
    expect(
      silenceAction(
        { lastEventAt: minus(ten, 1), silenceAlertedAt: minus(ten, 2) },
        at(ten)
      )
    ).toBe('restore');
  });
});

describe('checkPbxSilence', () => {
  const now = () => at('2026-10-12T06:00:00Z');

  it('moves each connection that needs it, and sums the bells', async () => {
    const fake = createFakeDb(
      {
        pbx_connections: [
          { id: 'quiet', last_event_at: '2026-10-12T05:00:00Z' },
          {
            id: 'back',
            last_event_at: '2026-10-12T05:59:00Z',
            silence_alerted_at: '2026-10-12T05:30:00Z',
          },
          { id: 'live', last_event_at: '2026-10-12T05:58:00Z' },
          { id: 'never', last_event_at: null },
        ],
      },
      {
        pbx_connection_silence: (args) => ({
          data: args.p_silent ? 2 : 3,
          error: null,
        }),
      }
    );
    expect(await checkPbxSilence({ db: fake.db, now })).toEqual({
      alerted: 2,
      restored: 3,
    });
    expect(
      fake.log.filter((l) => l.op === 'rpc').map((l) => l.payload)
    ).toEqual([
      { p_connection_id: 'quiet', p_silent: true, p_quiet_minutes: 15 },
      { p_connection_id: 'back', p_silent: false, p_quiet_minutes: 15 },
    ]);
  });

  it('carries on past a failed connection, then reports it', async () => {
    const fake = createFakeDb(
      {
        pbx_connections: [
          { id: 'a', last_event_at: '2026-10-12T05:00:00Z' },
          { id: 'b', last_event_at: '2026-10-12T05:00:00Z' },
        ],
      },
      {
        pbx_connection_silence: (args) =>
          args.p_connection_id === 'a'
            ? { data: null, error: { message: 'locked' } }
            : { data: 1, error: null },
      }
    );
    await expect(checkPbxSilence({ db: fake.db, now })).rejects.toThrow(
      'pbx_connection_silence failed: a: locked'
    );
    expect(fake.log.filter((l) => l.op === 'rpc')).toHaveLength(2);
  });

  it('throws when the connections cannot be read', async () => {
    const fake = createFakeDb({ pbx_connections: [] });
    fake.fail('pbx_connections', 'select', { message: 'down' });
    await expect(checkPbxSilence({ db: fake.db, now })).rejects.toThrow(
      'pbx_connections read failed: down'
    );
  });
});
