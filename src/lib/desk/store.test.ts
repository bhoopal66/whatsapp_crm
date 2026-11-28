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

  it('knows the hint 316 raises over a settings card gone stale', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/316_desk_rest.sql'),
      'utf8'
    );
    for (const fn of ['desk_settings_set', 'desk_digest_settings_set'])
      expect(sql).toContain(`desk_refuse('${fn}', 'SETTINGS_CHANGED'`);
    expect(DESK_REFUSALS).toContain('SETTINGS_CHANGED');
    expect(DESK_REFUSAL_HTTP.SETTINGS_CHANGED.status).toBe(409);
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

describe('settings versions (316)', () => {
  const V = '2026-11-24T08:00:00.123456+00:00';

  it('sends the version the card showed and answers the one saved', async () => {
    const { store, calls } = storeAnswering({});
    const saved = [
      await store.setSettings('u', 'a', {
        routingEnabled: true,
        deskChannelIds: [],
        escalateMinutes: 60,
        expectedUpdatedAt: V,
      }),
      await store.setDigestSettings('u', 'a', {
        enabled: false,
        templateName: null,
        language: 'en',
        sendHour: 10,
        gapDays: 2,
        expectedUpdatedAt: null,
      }),
    ];
    expect(calls.map((c) => [c.fn, c.args.p_expected, c.args.p_now])).toEqual([
      ['desk_settings_set', V, saved[0]],
      ['desk_digest_settings_set', null, saved[1]],
    ]);
  });

  it('reads the digest version with its microseconds', async () => {
    const { store, calls } = storeAnswering({
      data: [{ enabled: true, updated_at: V }],
    });
    expect((await store.digestSettings('u', 'a')).updatedAt).toBe(V);
    expect(calls[0].fn).toBe('desk_digest_settings_read');
  });
});

describe('tray search (329)', () => {
  const PAGE = { items: [], total: 0 };

  it('passes a search as p_q', async () => {
    const { store, calls } = storeAnswering({ data: [PAGE] });
    await store.tray('u', 'a', 'open', 100, 'أحمد');
    expect(calls[0].fn).toBe('desk_tray_page');
    expect(calls[0].args).toMatchObject({
      p_actor: 'u',
      p_account: 'a',
      p_state: 'open',
      p_limit: 100,
      p_q: 'أحمد',
    });
  });

  it('names no p_q for the unsearched tray', async () => {
    const { store, calls } = storeAnswering({ data: [PAGE] });
    await store.tray('u', 'a');
    expect(calls[0].args).not.toHaveProperty('p_q');
  });
});
