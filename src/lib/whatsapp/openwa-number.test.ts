import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { getSession, getQr } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getQr: vi.fn(),
}));

vi.mock('./openwa-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openwa-api')>()),
  getSession,
  getQr,
}));
vi.mock('./encryption', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./encryption')>()),
  decrypt: () => 'session-key',
}));

import { OpenWAError } from './openwa-api';
import {
  OPENWA_PROBE_CACHE_MS,
  OPENWA_PROBE_STALE_MS,
  probeOpenWANumber,
  resetOpenWAProbeCache,
  type OpenWARow,
} from './openwa-number';

const db = {} as SupabaseClient;
const row: OpenWARow = {
  id: 'cfg-1',
  phone_number_id: 'sess-1',
  access_token: 'enc',
  waba_id: null,
  status: 'connecting',
  connected_at: null,
  is_personal: false,
};
const throttled = () =>
  new OpenWAError('ThrottlerException: Too Many Requests', 429);

beforeEach(() => {
  resetOpenWAProbeCache();
  getSession.mockReset();
  getQr.mockReset();
});

describe('probeOpenWANumber — OpenWA throttling', () => {
  it('answers a throttled read with no last known state as a 429, not a 502', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(throttled());
    const res = await probeOpenWANumber(db, 'acct-1', row);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'The OpenWA gateway is busy. Try again shortly.',
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('answers a throttled read with the last known state, without the old QR', async () => {
    let t = 1_000_000;
    const now = () => t;
    getSession.mockResolvedValueOnce({ status: 'qr_ready' });
    getQr.mockResolvedValueOnce({ qrCode: 'data:qr' });
    const first = await probeOpenWANumber(db, 'acct-1', row, now);
    expect(await first.json()).toEqual({
      status: 'qr_ready',
      qrCode: 'data:qr',
    });

    t += OPENWA_PROBE_CACHE_MS;
    getSession.mockRejectedValueOnce(throttled());
    const second = await probeOpenWANumber(db, 'acct-1', row, now);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'qr_ready' });

    t += OPENWA_PROBE_STALE_MS;
    getSession.mockRejectedValueOnce(throttled());
    const third = await probeOpenWANumber(db, 'acct-1', row, now);
    expect(third.status).toBe(429);
  });

  it('still answers 502 for a gateway that really failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSession.mockRejectedValue(new OpenWAError('boom', 500));
    const res = await probeOpenWANumber(db, 'acct-1', row);
    expect(res.status).toBe(502);
    error.mockRestore();
  });
});

describe('probeOpenWANumber — per-number cache', () => {
  it('shares one gateway read between callers within the cache window', async () => {
    let t = 5_000_000;
    const now = () => t;
    getSession.mockResolvedValue({ status: 'initializing' });
    const answers = await Promise.all([
      probeOpenWANumber(db, 'acct-1', row, now),
      probeOpenWANumber(db, 'acct-1', row, now),
      probeOpenWANumber(db, 'acct-1', row, now),
    ]);
    t += OPENWA_PROBE_CACHE_MS - 1;
    answers.push(await probeOpenWANumber(db, 'acct-1', row, now));
    expect(getSession).toHaveBeenCalledTimes(1);
    for (const res of answers) {
      expect(await res.json()).toEqual({ status: 'initializing' });
    }

    t += 1;
    await probeOpenWANumber(db, 'acct-1', row, now);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('keeps numbers apart', async () => {
    getSession.mockResolvedValue({ status: 'initializing' });
    await probeOpenWANumber(db, 'acct-1', row);
    await probeOpenWANumber(db, 'acct-1', { ...row, id: 'cfg-2' });
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
