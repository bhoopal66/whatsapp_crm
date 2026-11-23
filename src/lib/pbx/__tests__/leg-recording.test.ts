import { describe, expect, it } from 'vitest';

import type { PbxHandle } from '../connection';
import { ingestPbxEvent } from '../process';
import { fetchPendingRecordings } from '../recordings';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const end = (
  leg: string,
  talk: number,
  recording: string,
  status?: string
) => ({
  type: 30012,
  sn: 'SN1',
  msg: {
    call_id: 'call-1',
    uid: 'uid-1',
    type: 'Inbound',
    call_from: '0500000000',
    call_to: leg,
    time_start: '2026-10-12 14:00:00',
    call_duration: talk + 5,
    talk_duration: talk,
    status: status ?? 'ANSWERED',
    did_number: '043334444',
    recording,
  },
});
const newDb = () =>
  createFakeDb({
    pbx_connections: [{ id: 'c1', account_id: 'a1', status: 'connected' }],
  });
const ingest = async (fake: FakeDb, payload: unknown) => {
  const res = await ingestPbxEvent({
    db: fake.db,
    connectionId: 'c1',
    payload,
    receivedAt: '2026-10-12T10:10:00.000Z',
  });
  expect(res.error).toBeUndefined();
};

describe('the recording of a call with several legs', () => {
  it('a longer leg replaces one not fetched yet, whatever came first', async () => {
    const fake = newDb();
    await ingest(fake, end('1001', 10, 'short.wav'));
    const row = fake.tables.calls[0];
    row.meta = {
      ...(row.meta as Row),
      recording_attempts: 2,
      recording_error: 'x',
    };
    await ingest(fake, end('1002', 300, 'long.wav'));
    expect(fake.tables.calls[0]).toMatchObject({
      recording_state: 'pending',
      recording_file: 'long.wav',
    });
    expect(fake.tables.calls[0].meta).not.toHaveProperty('recording_attempts');
    await ingest(fake, end('1003', 40, 'middle.wav'));
    expect(fake.tables.calls[0].recording_file).toBe('long.wav');
  });

  it('an answered leg beats the voicemail, and a held one stays held', async () => {
    const fake = newDb();
    await ingest(fake, end('1001', 60, 'vm.wav', 'VOICEMAIL'));
    expect(fake.tables.calls[0].recording_file).toBe('vm.wav');
    fake.tables.calls[0].recording_state = 'held';
    await ingest(fake, end('1002', 30, 'talk.wav'));
    expect(fake.tables.calls[0]).toMatchObject({
      recording_state: 'held',
      recording_file: 'talk.wav',
    });
  });

  it.each(['fetched', 'failed', 'not_stored', 'erased'])(
    'never replaces one already %s',
    async (recording_state) => {
      const fake = newDb();
      await ingest(fake, end('1001', 10, 'short.wav'));
      fake.tables.calls[0].recording_state = recording_state;
      await ingest(fake, end('1002', 300, 'long.wav'));
      expect(fake.tables.calls[0]).toMatchObject({
        recording_state,
        recording_file: 'short.wav',
      });
    }
  );

  it('a reference replaced during its download is fetched by the next run', async () => {
    const fake = createFakeDb({
      calls: [
        {
          id: 'k1',
          account_id: 'a1',
          connection_id: 'c1',
          recording_state: 'pending',
          recording_file: 'short.wav',
          meta: {},
          updated_at: 'u1',
        },
      ],
    });
    const asked: string[] = [];
    const run = () =>
      fetchPendingRecordings({
        db: fake.db,
        apiFor: async () =>
          ({
            api: {
              recordingDownloadUrl: async (ref: { file: string }) => {
                asked.push(ref.file);
                return 'https://pbx.example/x';
              },
            },
          }) as unknown as PbxHandle,
        fetch: async () => {
          if (asked.length === 1) {
            Object.assign(fake.tables.calls[0], {
              recording_file: 'long.wav',
              updated_at: 'u2',
            });
          }
          return new Response(new Uint8Array([1, 2]));
        },
      });
    expect(await run()).toMatchObject({ fetched: 0, failed: 0 });
    expect(fake.tables.calls[0].recording_state).toBe('pending');
    expect(await run()).toMatchObject({ fetched: 1 });
    expect(asked).toEqual(['short.wav', 'long.wav']);
    expect(fake.tables.calls[0].recording_state).toBe('fetched');
  });
});
