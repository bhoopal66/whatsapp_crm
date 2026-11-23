import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DESK_REFUSAL_HTTP } from './http';
import { QUEUE_REASON_KEYS } from './intake-form';
import {
  DESK_REFUSALS,
  DeskRefusedError,
  DeskStore,
  DeskStoreError,
} from './store';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/220_case_desk.sql'),
  'utf8'
);

describe('desk refusals', () => {
  it('knows every hint migration 220 raises', () => {
    const hints = new Set(
      [...SQL.matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map((m) => m[1])
    );
    expect(hints.size).toBeGreaterThan(10);
    for (const h of hints) expect(DESK_REFUSALS).toContain(h);
  });

  it('knows the hint 289 raises, as a refusal and as a queue reason', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/289_access_points.sql'),
      'utf8'
    );
    expect(sql).toContain("''intake_route'', ''COMPANY_RESTRICTED''");
    expect(DESK_REFUSALS).toContain('COMPANY_RESTRICTED');
    expect(QUEUE_REASON_KEYS).toContain('COMPANY_RESTRICTED');
  });

  it('answers every refusal with a status and wording', () => {
    for (const r of DESK_REFUSALS) {
      expect(DESK_REFUSAL_HTTP[r].status).toBeGreaterThanOrEqual(400);
      expect(DESK_REFUSAL_HTTP[r].text.length).toBeGreaterThan(0);
    }
  });
});

function storeAnswering(answer: { data?: unknown; error?: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  };
  const store = new DeskStore(
    db as never,
    () => new Date('2026-11-21T08:00:00Z')
  );
  return { store, calls };
}

describe('DeskStore', () => {
  it('maps a refusal hint to DeskRefusedError and anything else to DeskStoreError', async () => {
    const refused = storeAnswering({
      error: { code: '23514', hint: 'BANK_SCOPE' },
    });
    await expect(refused.store.reject('u', 'a', 'i', 'x')).rejects.toEqual(
      new DeskRefusedError('BANK_SCOPE')
    );
    const broken = storeAnswering({
      error: { code: '42P01', hint: 'secret table text' },
    });
    const err = await broken.store
      .reject('u', 'a', 'i', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeskStoreError);
    expect(String((err as Error).message)).not.toContain('secret');
  });

  it('passes the actor, active account and clock to submit', async () => {
    const { store, calls } = storeAnswering({
      data: [
        {
          item_id: 'i1',
          state: 'filed',
          case_id: 'c1',
          case_number: 'TC-26-00001-RAK',
          caption_code: '1RAK1',
          file_id: null,
          duplicate_of_item: null,
          queue_bank_code: null,
          queue_reason: null,
          replayed: false,
        },
      ],
    });
    const out = await store.submit('u1', 'acc1', {
      itemId: 'i1',
      idemKey: 'up-12345678',
      tags: {
        kind: 'info',
        bankCode: null,
        caseRef: '1RAK1',
        companyName: null,
        tradeLicence: null,
        product: null,
        contactId: null,
        docKey: null,
        note: 'hi',
      },
      file: null,
    });
    expect(calls[0]?.fn).toBe('intake_submit');
    expect(calls[0]?.args).toMatchObject({
      p_actor: 'u1',
      p_account: 'acc1',
      p_item: 'i1',
      p_case_ref: '1RAK1',
      p_storage_path: null,
      p_now: '2026-11-21T08:00:00.000Z',
    });
    expect(out).toMatchObject({
      state: 'filed',
      captionCode: '1RAK1',
      replayed: false,
    });
  });

  it('reads a scalar desk code lookup', async () => {
    const { store } = storeAnswering({ data: 'ENBD' });
    expect(await store.bankByShortCode('acc1', 'ENB')).toBe('ENBD');
    const none = storeAnswering({ data: null });
    expect(await none.store.bankByShortCode('acc1', 'XYZ')).toBeNull();
  });
});
