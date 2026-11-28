import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

let fake: FakeDb;
let role: AccountRole = 'admin';

class Forbidden extends Error {}
vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Forbidden('forbidden');
    return { supabase: fake.db, accountId: 'acc', userId: 'u', role };
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: String(err) },
      { status: err instanceof Forbidden ? 403 : 500 }
    ),
}));

import { DELETE, GET, POST, PUT } from './route';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const OLD_ID = '22222222-2222-4222-8222-222222222222';
const req = (method: string, body?: unknown, q = '') =>
  new Request(`http://localhost/api/pbx/service-details${q}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const SETTINGS = {
  enabled: true,
  templateName: 'call_service_details',
  language: 'en',
  minSeconds: 20,
  inbound: true,
  outbound: false,
};
let calls: { name: string; args: Record<string, unknown> }[];

beforeEach(() => {
  role = 'admin';
  calls = [];
  const rec =
    (name: string, data: unknown) => (args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data, error: null };
    };
  fake = createFakeDb(
    {
      message_templates: [
        {
          account_id: 'acc',
          name: 'call_service_details',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
        },
        {
          account_id: 'acc',
          name: 'promo',
          language: 'en',
          status: 'APPROVED',
          category: 'MARKETING',
        },
        {
          account_id: 'acc',
          name: 'pending_one',
          language: 'en',
          status: 'PENDING',
          category: 'UTILITY',
        },
        {
          account_id: 'other',
          name: 'theirs',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
        },
      ],
      pbx_service_map: [
        {
          id: ROW_ID,
          account_id: 'acc',
          match_type: 'queue',
          match_value: '6400',
          label: 'Mortgages',
        },
      ],
    },
    {
      pbx_service_details_settings_set: rec('set', '2026-11-28T10:00:00Z'),
      pbx_service_map_upsert: rec('upsert', ROW_ID),
      pbx_service_map_delete: rec('delete', true),
    }
  );
});

describe('/api/pbx/service-details: owners and admins only', () => {
  for (const r of ['team_leader', 'agent'] as const) {
    it(`refuses a ${r} on every method and writes nothing`, async () => {
      role = r;
      expect((await GET()).status).toBe(403);
      expect((await PUT(req('PUT', SETTINGS))).status).toBe(403);
      expect(
        (
          await POST(
            req('POST', { matchType: 'queue', matchValue: '1', label: 'x' })
          )
        ).status
      ).toBe(403);
      expect(
        (await DELETE(req('DELETE', undefined, `?id=${ROW_ID}`))).status
      ).toBe(403);
      expect(calls).toEqual([]);
    });
  }
});

describe('/api/pbx/service-details', () => {
  it('answers the defaults, the map and only approved utility templates', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toEqual({
      enabled: false,
      templateName: null,
      language: null,
      minSeconds: 20,
      inbound: true,
      outbound: false,
    });
    expect(json.templates).toEqual([
      { name: 'call_service_details', language: 'en' },
    ]);
    expect(json.map).toEqual([
      {
        id: ROW_ID,
        matchType: 'queue',
        matchValue: '6400',
        label: 'Mortgages',
      },
    ]);
    expect(json.recent).toEqual([]);
  });

  it('refuses switching on without a template, before the RPC', async () => {
    const res = await PUT(req('PUT', { ...SETTINGS, templateName: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_TEMPLATE');
    expect(calls).toEqual([]);
  });

  it('saves the settings through the setter RPC', async () => {
    const res = await PUT(req('PUT', SETTINGS));
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        name: 'set',
        args: {
          p_account: 'acc',
          p_enabled: true,
          p_template_name: 'call_service_details',
          p_language: 'en',
          p_min_seconds: 20,
          p_inbound: true,
          p_outbound: false,
        },
      },
    ]);
  });

  it('refuses a label over 60 characters', async () => {
    const res = await POST(
      req('POST', {
        matchType: 'did',
        matchValue: '800',
        label: 'x'.repeat(61),
      })
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('an edit that changes the key upserts the new row, then deletes the old', async () => {
    const res = await POST(
      req('POST', {
        matchType: 'queue',
        matchValue: ' 6401 ',
        label: 'Loans',
        replaces: OLD_ID,
      })
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual(['upsert', 'delete']);
    expect(calls[0].args.p_match_value).toBe('6401');
    expect(calls[1].args).toEqual({ p_account: 'acc', p_id: OLD_ID });
  });

  it('maps the RPC INVALID hint to 400', async () => {
    fake.rpcs.pbx_service_map_delete = () => ({
      data: null,
      error: { code: '23514', hint: 'INVALID', message: 'x' },
    });
    const res = await DELETE(req('DELETE', undefined, `?id=${ROW_ID}`));
    expect(res.status).toBe(400);
  });
});
