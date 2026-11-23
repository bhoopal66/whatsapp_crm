import { expect, it, vi } from 'vitest';

import { ingestPbxEvent } from '../process';
import { createFakeDb } from './fake-db';

const frame = {
  type: 30011,
  sn: 'SN1',
  msg: JSON.stringify({
    call_id: 'call-1',
    members: [
      {
        inbound: {
          from: '0500000000',
          to: '043334444',
          trunk_name: 'T1',
          channel_id: 'in-1',
          member_status: 'RING',
        },
      },
      {
        extension: {
          number: '1001',
          channel_id: 'ch-1001',
          member_status: 'RING',
        },
      },
    ],
  }),
};

/** A ring frame, with the call's row set to `status` while it is written. */
async function ringWhile(status: string) {
  const fake = createFakeDb({
    pbx_connections: [{ id: 'c1', account_id: 'a1', status: 'connected' }],
    calls: [
      {
        id: 'row-1',
        connection_id: 'c1',
        pbx_call_id: 'call-1',
        account_id: 'a1',
        direction: 'inbound',
        status: 'ringing',
        started_at: '2026-10-12T10:00:00.000Z',
      },
    ],
  });
  const from = fake.db.from.bind(fake.db);
  let first = true;
  vi.spyOn(fake.db, 'from').mockImplementation(((table: string) => {
    if (table === 'call_live' && first) {
      // The end, whole: its row written, its delete of call_live done.
      first = false;
      fake.tables.calls[0].status = status;
    }
    return from(table);
  }) as typeof fake.db.from);
  const res = await ingestPbxEvent({
    db: fake.db,
    connectionId: 'c1',
    payload: frame,
    receivedAt: '2026-10-12T10:00:05.000Z',
  });
  expect(res.error).toBeUndefined();
  return fake;
}

it('a ring frame that crosses the call end leaves no ghost on the screens', async () => {
  const fake = await ringWhile('answered');
  expect(fake.tables.call_live ?? []).toEqual([]);
  expect(fake.tables.calls[0].status).toBe('answered');
});

it('a ring frame of a call still live keeps its row', async () => {
  const fake = await ringWhile('ringing');
  expect(fake.tables.call_live).toHaveLength(1);
});
