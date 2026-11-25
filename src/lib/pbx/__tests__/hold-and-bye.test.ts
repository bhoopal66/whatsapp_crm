import { beforeEach, describe, expect, it, vi } from 'vitest';

import { myRingingCall, type CallLiveRow } from '../call-ui';
import { ingestPbxEvent } from '../process';
import { createFakeDb, type FakeDb } from './fake-db';

const inbound = (member_status: string) => ({
  inbound: {
    from: '0500000000',
    to: '043334444',
    trunk_name: 'T1',
    channel_id: 'in-1',
    member_status,
  },
});
const ext = (number: string, member_status: string, ch = `ch-${number}`) => ({
  extension: { number, channel_id: ch, member_status },
});

let fake: FakeDb;
const at = (s: number) =>
  new Date(Date.parse('2026-11-25T10:00:00.000Z') + s * 1000).toISOString();
async function frame(s: number, ...members: object[]) {
  const res = await ingestPbxEvent({
    db: fake.db,
    connectionId: 'c1',
    // `t` only makes each frame's hash its own.
    payload: {
      type: 30011,
      sn: 'SN1',
      t: at(s),
      msg: JSON.stringify({ call_id: 'call-1', members }),
    },
    receivedAt: at(s),
  });
  expect(res.error).toBeUndefined();
}
const live = () => fake.tables.call_live ?? [];
const meta = () => fake.tables.calls[0].meta as Record<string, unknown>;

beforeEach(() => {
  fake = createFakeDb({
    pbx_connections: [{ id: 'c1', account_id: 'a1', status: 'connected' }],
    pbx_extensions: ['1001', '1002'].map((extension, i) => ({
      id: `x${i + 1}`,
      connection_id: 'c1',
      account_id: 'a1',
      extension,
      user_id: `u${i + 1}`,
    })),
    calls: [
      {
        id: 'row-1',
        connection_id: 'c1',
        pbx_call_id: 'call-1',
        account_id: 'a1',
        direction: 'inbound',
        status: 'in_progress',
        started_at: at(0),
        updated_at: at(0),
        meta: { rang_user_ids: ['u1'] },
      },
    ],
  });
});

describe('a customer on hold', () => {
  it.each([
    ['the extension', inbound('ANSWERED'), ext('1001', 'HOLD')],
    ['the trunk', inbound('HOLD'), ext('1001', 'ANSWERED')],
    ['both', inbound('HOLD'), ext('1001', 'HOLD')],
  ])('keeps its holder when the PBX marks %s', async (_, trunk, mine) => {
    await frame(1, inbound('ANSWERED'), ext('1001', 'ANSWERED'));
    await frame(2, trunk, mine);
    expect(live()).toMatchObject([{ answered_by: 'u1', state: 'answered' }]);
  });

  it('goes to whoever answers, not to the holder', async () => {
    await frame(1, inbound('HOLD'), ext('1001', 'HOLD'), ext('1002', 'ANSWER'));
    expect(live()).toMatchObject([{ answered_by: 'u2' }]);
  });

  it('credits nobody new for a hold', async () => {
    await frame(1, inbound('ANSWERED'), ext('1001', 'HOLD'));
    expect(meta()).not.toHaveProperty('answered_user_ids');
  });

  it('still rings the colleague it is being passed to, and not the holder', async () => {
    await frame(
      1,
      inbound('HOLD'),
      ext('1001', 'HOLD'),
      ext('1002', 'RING'),
      ext('1001', 'RING', 'ch-1001-b')
    );
    expect(live()).toMatchObject([{ answered_by: 'u1', state: 'ringing' }]);
    const rows = live() as unknown as CallLiveRow[];
    expect(myRingingCall(rows, 'u2')).not.toBeNull();
    expect(myRingingCall(rows, 'u1')).toBeNull();
  });
});

describe('frames around the all-BYE frame', () => {
  const talk = [inbound('ANSWERED'), ext('1001', 'ANSWERED')];
  const bye = [inbound('BYE'), ext('1001', 'BYE')];

  it('a slower earlier frame does not bring the call back', async () => {
    await frame(1, ...talk);
    await frame(10, ...bye);
    expect(live()).toHaveLength(0);
    expect(meta()).toMatchObject({
      rang_user_ids: ['u1'],
      answered_user_ids: ['u1'],
      bye_at: at(10),
    });
    // Received before it, and just after it.
    await frame(9, ...talk);
    await frame(11, inbound('HOLD'), ext('1001', 'ANSWERED'));
    expect(live()).toHaveLength(0);
  });

  it('a late ring still counts who it rang', async () => {
    await frame(10, ...bye);
    await frame(9, inbound('ALERT'), ext('1002', 'RING'));
    expect(live()).toHaveLength(0);
    expect(meta()).toMatchObject({
      rang_user_ids: ['u1', 'u2'],
      bye_at: at(10),
    });
  });

  it('a frame caught half-way by the hang-up removes its own row', async () => {
    const from = fake.db.from.bind(fake.db);
    let first = true;
    vi.spyOn(fake.db, 'from').mockImplementation(((table: string) => {
      if (table === 'call_live' && first) {
        // The all-BYE frame, whole: stamped, its delete done.
        first = false;
        fake.tables.calls[0].meta = {
          bye_at: at(10),
          bye_channels: ['in-1', 'ch-1001'],
        };
      }
      return from(table);
    }) as typeof fake.db.from);
    await frame(9, ...talk);
    expect(live()).toHaveLength(0);
    expect(meta()).toMatchObject({ bye_at: at(10) });
  });

  it('a call that goes on with a new leg keeps its screen pop', async () => {
    await frame(1, ...talk);
    // Only the leaver's leg, as a delta frame would say it.
    await frame(10, ext('1001', 'BYE'));
    await frame(11, inbound('ANSWERED'), ext('1002', 'ANSWERED'));
    expect(live()).toMatchObject([{ answered_by: 'u2' }]);
    // The same extension, on a new channel.
    await frame(12, inbound('ANSWERED'), ext('1001', 'ANSWERED', 'ch-new'));
    expect(live()).toMatchObject([{ answered_by: 'u1' }]);
  });

  it('is believed again after a minute', async () => {
    await frame(10, ...bye);
    await frame(71, ...talk);
    expect(live()).toHaveLength(1);
  });

  it('a hang-up that cannot be remembered still clears the screen', async () => {
    await frame(1, ...talk);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.tables.calls[0].status = 'in_progress';
    const from = fake.db.from.bind(fake.db);
    vi.spyOn(fake.db, 'from').mockImplementation(((table: string) => {
      if (table === 'calls') throw new Error('down');
      return from(table);
    }) as typeof fake.db.from);
    await frame(10, ...bye);
    expect(live()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('hang-up not remembered')
    );
  });
});
