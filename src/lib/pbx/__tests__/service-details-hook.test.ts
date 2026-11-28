import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../service-details-store', () => ({
  sendCallServiceDetails: h.send,
}));

import { ingestPbxEvent } from '../process';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

// The call end hands the written call to the service details sender.

const A = 'acc';
const NOW = '2026-10-12T10:30:00.000Z';
let fake: FakeDb;

const end = (callId: string, extra: Row = {}) => ({
  type: 30012,
  sn: 'SN1',
  msg: {
    call_id: callId,
    uid: `uid-${callId}`,
    type: 'Inbound',
    call_from: '0501234567',
    call_to: '1001',
    time_start: '2026-10-12 14:05:00',
    call_duration: 70,
    talk_duration: 60,
    status: 'ANSWERED',
    ...extra,
  },
});
const ingest = (payload: unknown) =>
  ingestPbxEvent({ db: fake.db, connectionId: 'c1', payload, receivedAt: NOW });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.send.mockReset().mockResolvedValue('sent');
  fake = createFakeDb(
    {
      pbx_connections: [{ id: 'c1', account_id: A, status: 'ok' }],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: A,
          user_id: 'u1',
        },
      ],
      contacts: [],
      profiles: [],
      calls: [],
      tasks: [],
    },
    {},
    { calls: { updated_at: '1' } }
  );
});

describe('call service details hook', () => {
  it('runs once the calls row is written, with the merged call', async () => {
    let rowAtSend: Row | undefined;
    h.send.mockImplementation(async () => {
      rowAtSend = fake.tables.calls.find((c) => c.pbx_call_id === 'call-1');
      return 'sent';
    });
    await ingest(end('call-1'));
    expect(rowAtSend).toBeDefined();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(fake.db, {
      callRowId: rowAtSend?.id,
      accountId: A,
      direction: 'inbound',
      answered: true,
      agentExtension: '1001',
      agentKnown: true,
      talkSeconds: 60,
      customerNumber: '+971501234567',
      queue: null,
      did: null,
    });
  });

  it('a missed call is not handed over', async () => {
    await ingest(end('call-2', { status: 'NO ANSWER', talk_duration: 0 }));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a throwing sender never escapes the call end', async () => {
    h.send.mockRejectedValue(new Error('boom'));
    const r = await ingest(end('call-3'));
    expect(r).not.toHaveProperty('error');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(
      fake.tables.calls.find((c) => c.pbx_call_id === 'call-3')
    ).toBeDefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('service details: boom')
    );
  });
});
