import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const deliverSigned = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/webhooks/deliver', () => ({ deliverSigned }));

import { WEBHOOK_EVENTS } from './events';
import {
  drainWebhookOutbox,
  OUTBOX_CLAIM_LIMIT,
  purgeWebhookOutbox,
} from './outbox';

const rpc = vi.fn();
const db = { rpc } as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drainWebhookOutbox', () => {
  it('claims at most the limit and delivers each row through the shared signer', async () => {
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
      p_limit: OUTBOX_CLAIM_LIMIT,
    });
    expect(OUTBOX_CLAIM_LIMIT).toBe(200);
    expect(res).toEqual({ claimed: 2, delivered: 2 });
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
    expect(await drainWebhookOutbox(db)).toEqual({ claimed: 1, delivered: 0 });
    expect(deliverSigned).not.toHaveBeenCalled();
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
