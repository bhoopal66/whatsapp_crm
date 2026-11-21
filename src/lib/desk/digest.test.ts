import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DigestRefusal,
  isStopWord,
  noteDigestStop,
  runDeskDigests,
} from './digest';
import { DESK_REFUSALS } from './store';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('isStopWord', () => {
  it('takes the whole reply, any case, Arabic too', () => {
    for (const t of ['STOP', ' stop. ', 'Unsubscribe', 'توقف', 'إيقاف!'])
      expect(isStopWord(t), t).toBe(true);
    for (const t of ['please stop sending the licence?', 'stopped', '', null])
      expect(isStopWord(t as string), String(t)).toBe(false);
  });
});

function fakeDb(claims: unknown[]) {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (fn === 'desk_digest_enqueue') return { data: 2, error: null };
      if (fn === 'desk_digest_claim') return { data: claims, error: null };
      return { data: true, error: null };
    }),
  };
}

const CLAIM = {
  id: 'o1',
  account_id: 'a1',
  contact_id: 'c1',
  conversation_id: 'v1',
  app_number: 'TC-26-00001',
  summary: 'All banks: Ejari',
  template_name: 'desk_digest',
  language: 'en',
};

describe('runDeskDigests', () => {
  it('queues, sends each claim once and marks it', async () => {
    const db = fakeDb([CLAIM]);
    const send = vi
      .fn()
      .mockResolvedValue({ providerMessageId: 'w1', messageId: 'm1' });
    const s = await runDeskDigests(db as never, send);
    expect(s).toEqual({ queued: 2, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      appNumber: 'TC-26-00001',
      summary: 'All banks: Ejari',
    });
    expect(db.calls.at(-1)).toEqual([
      'desk_digest_mark',
      expect.objectContaining({
        p_id: 'o1',
        p_outcome: 'sent',
        p_provider_message_id: 'w1',
        p_message_id: 'm1',
      }),
    ]);
  });

  it('marks a refusal by its code and an error by its name only', async () => {
    const db = fakeDb([CLAIM, { ...CLAIM, id: 'o2' }]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new DigestRefusal('template_rejected'))
      .mockRejectedValueOnce(new Error('+971500000001 is not on WhatsApp'));
    const s = await runDeskDigests(db as never, send);
    expect(s).toEqual({ queued: 2, sent: 0, failed: 2 });
    const marks = db.calls
      .filter(([fn]) => fn === 'desk_digest_mark')
      .map(([, a]) => a.p_reason);
    expect(marks).toEqual(['template_rejected', 'Error']);
  });

  it('never throws when the database fails', async () => {
    const db = { rpc: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(runDeskDigests(db as never, vi.fn())).resolves.toBeNull();
  });
});

describe('noteDigestStop', () => {
  it('asks the SQL only for a STOP word', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
    expect(await noteDigestStop(db, 'a1', 'c1', 'hello')).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(await noteDigestStop(db, 'a1', 'c1', 'STOP')).toBe(true);
    expect(db.rpc).toHaveBeenCalledWith('desk_digest_stop', {
      p_account: 'a1',
      p_contact: 'c1',
    });
  });
});

describe('migration 234', () => {
  it('raises only hints the desk knows', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/234_desk_reminder_digest.sql'),
      'utf8'
    );
    const hints = new Set(
      [...sql.matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map((m) => m[1])
    );
    expect(hints.size).toBeGreaterThan(1);
    for (const x of hints)
      expect(DESK_REFUSALS as readonly string[]).toContain(x);
  });
});
