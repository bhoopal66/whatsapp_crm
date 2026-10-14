import { describe, expect, it } from 'vitest';
import { createFakeDb } from './__tests__/fake-db';
import {
  mapLimit,
  queueCallStatus,
  workspaceExtensions,
} from './groups-server';

describe('queueCallStatus', () => {
  it('names queue/agent_status call_status 0–5, else unknown', () => {
    expect([0, 1, 2, 3, 4, 5, 6, -1, 1.5].map(queueCallStatus)).toEqual([
      'unknown',
      'idle',
      'in_call',
      'ringing',
      'waiting',
      'on_hold',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });
});

describe('mapLimit', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 5, async () => 1)).toEqual([]);
  });
});

describe('workspaceExtensions', () => {
  it('maps the connection’s mapped extensions to people of this workspace', async () => {
    const { db } = createFakeDb({
      pbx_extensions: [
        { connection_id: 'c1', extension: '201', user_id: 'u1' },
        { connection_id: 'c1', extension: '202', user_id: 'u2' },
        { connection_id: 'c1', extension: '209', user_id: null },
        { connection_id: 'c2', extension: '301', user_id: 'u1' },
      ],
      profiles: [
        { user_id: 'u1', account_id: 'a', full_name: ' Amal ' },
        { user_id: 'u2', account_id: 'b', full_name: 'Elsewhere' },
      ],
    });
    expect([...(await workspaceExtensions(db, 'a', 'c1'))]).toEqual([
      ['201', { userId: 'u1', name: 'Amal' }],
      ['202', { userId: 'u2', name: null }],
    ]);
  });
});
