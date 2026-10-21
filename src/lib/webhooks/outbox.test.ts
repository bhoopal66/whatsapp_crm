import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const deliverSigned = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/webhooks/deliver', () => ({ deliverSigned }));

import { WEBHOOK_EVENTS } from './events';
import {
  drainWebhookOutbox,
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_LIMIT,
  purgeWebhookOutbox,
} from './outbox';

const rpc = vi.fn();
const db = { rpc } as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drainWebhookOutbox', () => {
  it('claims one batch and delivers each row through the shared signer', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          id: 1,
          account_id: 'acct-1',
          event: 'case.stage_changed',
          payload: { case_id: 'k1', occurred_at: '2026-10-21T10:00:00Z' },
          created_at: '2026-10-21T10:00:01Z',
        },
        {
          id: 2,
          account_id: 'acct-2',
          event: 'contact.opted_out',
          payload: { contact_id: 'c1' },
          created_at: '2026-10-21T10:00:02Z',
        },
      ],
      error: null,
    });
    const res = await drainWebhookOutbox(db);
    expect(rpc).toHaveBeenCalledWith('webhook_outbox_claim', {
      p_limit: OUTBOX_BATCH_SIZE,
    });
    expect(OUTBOX_CLAIM_LIMIT).toBe(200);
    expect(OUTBOX_BATCH_SIZE).toBe(10);
    expect(res).toEqual({
      claimed: 2,
      delivered: 2,
      failed: 0,
      stoppedEarly: false,
    });
    expect(deliverSigned).toHaveBeenNthCalledWith(
      1,
      db,
      'acct-1',
      'case.stage_changed',
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        event: 'case.stage_changed',
        occurred_at: '2026-10-21T10:00:00Z',
        account_id: 'acct-1',
        data: { case_id: 'k1', occurred_at: '2026-10-21T10:00:00Z' },
      }
    );
    // No occurred_at in the payload: the row's created_at.
    expect(deliverSigned).toHaveBeenNthCalledWith(
      2,
      db,
      'acct-2',
      'contact.opted_out',
      expect.objectContaining({ occurred_at: '2026-10-21T10:00:02Z' })
    );
  });

  it('skips a row whose event is not in the vocabulary', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({
      data: [
        { id: 3, account_id: 'a', event: 'nope', payload: {}, created_at: 'x' },
      ],
      error: null,
    });
    expect(await drainWebhookOutbox(db)).toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
      stoppedEarly: false,
    });
    expect(deliverSigned).not.toHaveBeenCalled();
  });

  const full = (n: number) => ({
    data: Array.from({ length: n }, (_, i) => ({
      id: i,
      account_id: 'a',
      event: 'case.stage_changed',
      payload: {},
      created_at: 'x',
    })),
    error: null,
  });

  it('stops claiming once the deadline has passed, leaving the rest unclaimed', async () => {
    rpc.mockResolvedValue(full(OUTBOX_BATCH_SIZE));
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 20_000; // start=0, first check 20s, second check 40s > 30s
      return v;
    });
    const res = await drainWebhookOutbox(db, { deadlineMs: 30_000, now });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      claimed: OUTBOX_BATCH_SIZE,
      delivered: OUTBOX_BATCH_SIZE,
      failed: 0,
      stoppedEarly: true,
    });
  });

  it('stops when a claim returns fewer rows than asked', async () => {
    rpc
      .mockResolvedValueOnce(full(OUTBOX_BATCH_SIZE))
      .mockResolvedValueOnce(full(3));
    const res = await drainWebhookOutbox(db, { now: () => 0 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(res.claimed).toBe(OUTBOX_BATCH_SIZE + 3);
    expect(res.stoppedEarly).toBe(false);
  });

  it('stops at the overall row cap', async () => {
    rpc.mockResolvedValue(full(OUTBOX_BATCH_SIZE));
    const res = await drainWebhookOutbox(db, { now: () => 0 });
    expect(rpc).toHaveBeenCalledTimes(OUTBOX_CLAIM_LIMIT / OUTBOX_BATCH_SIZE);
    expect(res.claimed).toBe(OUTBOX_CLAIM_LIMIT);
  });

  it('counts a rejected delivery as failed and still delivers the rest', async () => {
    rpc.mockResolvedValue(full(2));
    deliverSigned.mockRejectedValueOnce(new Error('boom'));
    const res = await drainWebhookOutbox(db, { now: () => 0 });
    expect(res).toMatchObject({ claimed: 2, delivered: 1, failed: 1 });
  });

  it('throws when the claim fails, delivering nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    await expect(drainWebhookOutbox(db)).rejects.toThrow(/claim/);
    expect(deliverSigned).not.toHaveBeenCalled();
  });
});

describe('purgeWebhookOutbox', () => {
  it('returns the purged count', async () => {
    rpc.mockResolvedValue({ data: 4, error: null });
    expect(await purgeWebhookOutbox(db)).toBe(4);
    expect(rpc).toHaveBeenCalledWith('webhook_outbox_purge');
  });

  it('throws on failure', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    await expect(purgeWebhookOutbox(db)).rejects.toThrow(/purge/);
  });
});

describe('the vocabulary covers migration 134', () => {
  it('every event 134 enqueues is a WEBHOOK_EVENTS entry', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/134_compass_case_sync.sql'),
      'utf8'
    );
    const enqueued = [
      ...sql.matchAll(/webhook_enqueue\([^,]+,\s*'([a-z_.]+)'/g),
    ].map((m) => m[1]);
    expect(enqueued).toHaveLength(6);
    for (const e of enqueued)
      expect(WEBHOOK_EVENTS as readonly string[]).toContain(e);
  });
});
