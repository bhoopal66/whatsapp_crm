import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/submission-groups/test-db';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  admin: null as unknown,
  rls: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', async () => {
  const { SubmissionGroupStore } =
    await import('@/lib/submission-groups/store');
  return {
    supabaseAdmin: () => m.admin,
    submissionGroupStore: (c?: unknown) =>
      new SubmissionGroupStore((c ?? m.admin) as never),
  };
});

import { GET } from './route';

const A = '11111111-1111-4111-8111-11111111111a';
const A2 = '11111111-1111-4111-8111-11111111111b';
const E = '22222222-2222-4222-8222-22222222222e';
const X = '33333333-3333-4333-8333-33333333333f';

const group = (over: Record<string, unknown>) => ({
  account_id: 'acct-1',
  submission_ref: 'SUB-1',
  contact_id: 'c1',
  channel_id: 'w1',
  subject: 'Jane · SUB-1',
  coordinator_phone: null,
  status: 'ACTIVE',
  wa_group_id: '120363000000000001@g.us',
  invite_link: null,
  submission_status: null,
  created_at: '2026-10-01T10:00:00.000Z',
  last_activity_at: '2026-10-10T10:00:00.000Z',
  ended_at: null,
  end_reason: null,
  wa_create_error: null,
  wa_closed_at: null,
  wa_close_error: null,
  invite_sent_at: null,
  invite_send_error: null,
  ...over,
});

let admin: FakeDb;
let rls: FakeDb;
let readable: Set<string>;

const get = (qs = '') =>
  GET(new Request(`http://x/api/submission-groups${qs}`));

const as = (role: string) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role,
    supabase: m.rls,
  });

beforeEach(() => {
  vi.clearAllMocks();
  readable = new Set();
  const ended = group({
    id: E,
    submission_ref: 'SUB-9',
    status: 'ENDED',
    ended_at: '2026-10-12T00:00:00.000Z',
    end_reason: 'final_status',
    contact_id: null,
    channel_id: null,
  });
  admin = {
    tables: {
      submission_groups: [
        ended,
        group({
          id: X,
          account_id: 'acct-2',
          status: 'ENDED',
          ended_at: '2026-10-13T00:00:00.000Z',
        }),
      ],
      submission_group_access: [
        {
          group_id: E,
          account_id: 'acct-1',
          user_id: 'u-me',
          label: 'coordinator',
          removed_at: '2026-10-12T00:00:00.000Z',
        },
      ],
      contacts: [
        { id: 'c1', account_id: 'acct-1', name: 'Jane Doe', phone: '9715' },
        { id: 'c2', account_id: 'acct-1', name: 'Omar', phone: '9716' },
      ],
      whatsapp_config: [
        { id: 'w1', account_id: 'acct-1', label: null, waba_id: '971500' },
      ],
    },
    rpc: { sg_can_read: (a) => readable.has(String(a.p_group)) },
  };
  // What RLS hands the caller: ACTIVE groups they are on, never ENDED ones.
  rls = {
    tables: {
      submission_groups: [
        group({ id: A }),
        group({
          id: A2,
          submission_ref: 'REF-7',
          customer_name: 'Gulf Star Trading LLC',
          submission_status: 'Inhouse Review',
          contact_id: 'c2',
          wa_group_id: null,
          last_activity_at: '2026-10-09T10:00:00.000Z',
        }),
      ],
      submission_group_access: [
        {
          group_id: A,
          account_id: 'acct-1',
          user_id: 'u-me',
          label: 'agent',
          removed_at: null,
        },
      ],
    },
  };
  m.admin = fakeSupabase(admin);
  m.rls = fakeSupabase(rls);
  as('agent');
});

describe('GET /api/submission-groups', () => {
  it('labels an ACTIVE group coordinator when the caller holds its case bank (163)', async () => {
    admin.tables.coordinator_banks = [
      { account_id: 'acct-1', user_id: 'u-me', bank_code: 'ADCB' },
      { account_id: 'acct-1', user_id: 'u-other', bank_code: 'FAB' },
    ];
    admin.tables.cases = [
      { account_id: 'acct-1', group_id: A, bank_code: 'FAB' },
      { account_id: 'acct-1', group_id: A2, bank_code: 'ADCB' },
    ];
    const body = await (await get()).json();
    // A keeps its real row label; A2 (no row) is a bank fallback.
    expect(body.groups.map((g: { my_label: string }) => g.my_label)).toEqual([
      'agent',
      'coordinator',
    ]);
  });

  it('labels an ACTIVE group team_lead when the caller leads its agent (173)', async () => {
    as('team_leader');
    const asked: unknown[] = [];
    admin.rpc = {
      sg_leads_group_agent: (a) => {
        asked.push(a.p_group);
        return a.p_group === A2;
      },
    };
    admin.tables.coordinator_banks = [
      { account_id: 'acct-1', user_id: 'u-me', bank_code: 'ADCB' },
    ];
    admin.tables.cases = [
      { account_id: 'acct-1', group_id: A2, bank_code: 'ADCB' },
    ];
    const body = await (await get()).json();
    // A keeps its real row label and is not asked about; on A2 leading the
    // agent beats holding the bank.
    expect(body.groups.map((g: { my_label: string }) => g.my_label)).toEqual([
      'agent',
      'team_lead',
    ]);
    expect(asked).toEqual([A2]);
  });

  it('does not ask whether an admin leads the agent', async () => {
    as('admin');
    const asked: unknown[] = [];
    admin.rpc = {
      sg_leads_group_agent: (a) => {
        asked.push(a.p_group);
        return true;
      },
    };
    const body = await (await get()).json();
    expect(body.groups[1].my_label).toBeNull();
    expect(asked).toEqual([]);
  });

  it('counts a failed lookup as not led', async () => {
    as('team_leader');
    admin.rpc = {
      sg_leads_group_agent: () => {
        throw new Error('down');
      },
    };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups[1].my_label).toBeNull();
  });

  it('gives no bank fallback to an admin', async () => {
    as('admin');
    admin.tables.coordinator_banks = [
      { account_id: 'acct-1', user_id: 'u-me', bank_code: 'ADCB' },
    ];
    admin.tables.cases = [
      { account_id: 'acct-1', group_id: A2, bank_code: 'ADCB' },
    ];
    const body = await (await get()).json();
    expect(body.groups[1].my_label).toBeNull();
  });

  it('lists the ACTIVE groups RLS hands the caller, newest activity first', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next_cursor).toBeNull();
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual([A, A2]);
    expect(body.groups[0]).toEqual({
      id: A,
      submission_ref: 'SUB-1',
      subject: 'Jane · SUB-1',
      customer_name: null,
      submission_status: null,
      bank: null,
      status: 'ACTIVE',
      contact: { id: 'c1', name: 'Jane Doe', phone: '9715' },
      channel: { id: 'w1', label: '971500' },
      my_label: 'agent',
      last_activity_at: '2026-10-10T10:00:00.000Z',
      created_at: '2026-10-01T10:00:00.000Z',
      ended_at: null,
      end_reason: null,
      wa_mode: 'group',
      customer_membership: 'unknown',
      pending: false,
      archive: false,
      unread: 0,
    });
    expect(body.groups[1]).toMatchObject({
      my_label: null,
      pending: true,
      // The tracker's company titles the group, not the contact's own name.
      customer_name: 'Gulf Star Trading LLC',
      contact: { id: 'c2', name: 'Omar' },
      submission_status: 'Inhouse Review',
    });
    expect(admin.log?.some(([t]) => t === 'submission_groups')).toBe(false);
  });

  it('lists every group at unread 0 when sg_unread_by_group fails', async () => {
    // No handler: the fake answers PGRST202, as before 173 is applied.
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups.map((g: { unread: number }) => g.unread)).toEqual([
      0, 0,
    ]);
  });

  it('lists every group at unread 0 when sg_unread_by_group throws', async () => {
    rls.rpc = {
      sg_unread_by_group: () => {
        throw new Error('network');
      },
    };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups.map((g: { unread: number }) => g.unread)).toEqual([
      0, 0,
    ]);
  });

  it("puts the caller's unread count on the group it belongs to", async () => {
    rls.rpc = { sg_unread_by_group: () => [{ group_id: A2, unread: 3 }] };
    const body = await (await get()).json();
    expect(
      body.groups.map((g: { id: string; unread: number }) => [g.id, g.unread])
    ).toEqual([
      [A, 0],
      [A2, 3],
    ]);
  });

  it('counts the unread messages of ENDED groups (308)', async () => {
    as('admin');
    readable.add(E);
    rls.rpc = { sg_unread_by_group: () => [{ group_id: E, unread: 3 }] };
    const body = await (await get('?status=ended')).json();
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual([E]);
    expect(body.groups[0].unread).toBe(3);
    expect(body.ended_unread).toEqual([]);
  });

  it('puts ENDED groups with unread messages beside the Active list (308)', async () => {
    readable = new Set([E, X]);
    rls.rpc = {
      sg_unread_by_group: () => [
        { group_id: A, unread: 1 },
        { group_id: E, unread: 2 },
        { group_id: X, unread: 4 },
      ],
    };
    const body = await (await get()).json();
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual([A, A2]);
    expect(body.ended_unread).toMatchObject([
      { id: E, status: 'ENDED', archive: true, unread: 2, my_label: null },
    ]);
    const searched = await (await get('?q=Jane')).json();
    expect(searched.ended_unread).toEqual([]);
    readable = new Set();
    expect((await (await get()).json()).ended_unread).toEqual([]);
  });

  it("never lists another account's group, even if a client returned it", async () => {
    rls.tables.submission_groups.push(
      group({ id: X, account_id: 'acct-2', last_activity_at: '2026-10-11' })
    );
    const ids = (await (await get()).json()).groups.map(
      (g: { id: string }) => g.id
    );
    expect(ids).not.toContain(X);
  });

  it('pages by last_activity_at', async () => {
    const first = await (await get('?limit=1')).json();
    expect(first.groups.map((g: { id: string }) => g.id)).toEqual([A]);
    expect(typeof first.next_cursor).toBe('string');
    const second = await (
      await get(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`)
    ).json();
    expect(second.groups.map((g: { id: string }) => g.id)).toEqual([A2]);
  });

  it.each(['active', 'ended'])(
    'lists every %s group once when a page ends inside a timestamp tie',
    async (status) => {
      const ended = status === 'ended';
      if (ended) as('admin');
      const T = '2026-10-05T10:00:00.000Z';
      const ids = [1, 2, 3, 4, 5].map(
        (n) => `44444444-4444-4444-8444-44444444444${n}`
      );
      const rows = ids.map((id) =>
        group({
          id,
          status: ended ? 'ENDED' : 'ACTIVE',
          last_activity_at: T,
          ended_at: ended ? T : null,
        })
      );
      (ended ? admin : rls).tables.submission_groups.push(...rows);
      if (ended) ids.forEach((id) => readable.add(id));
      const seen: string[] = [];
      let cursor = '';
      for (let i = 0; i < 10; i++) {
        const body = await (
          await get(
            `?status=${status}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
          )
        ).json();
        seen.push(...body.groups.map((g: { id: string }) => g.id));
        if (!body.next_cursor) break;
        cursor = body.next_cursor;
      }
      const tied = seen.filter((id) => ids.includes(id));
      expect(tied).toEqual([...ids].reverse());
      expect(new Set(seen).size).toBe(seen.length);
    }
  );

  it.each(['active', 'ended'])(
    'pages %s groups by the exact microsecond sort time PostgREST returns',
    async (status) => {
      const ended = status === 'ended';
      if (ended) as('admin');
      // Three rows tied at .123456 and one at .123400: a cursor cut to
      // the millisecond (.123) equals neither and skips every one of them.
      const TIE = '2026-10-05T10:00:00.123456+00:00';
      const NEAR = '2026-10-05T10:00:00.123400+00:00';
      const ids = [1, 2, 3, 4].map(
        (n) => `55555555-5555-4555-8555-55555555555${n}`
      );
      const at = (n: number) => (n === 3 ? NEAR : TIE);
      const rows = ids.map((id, n) =>
        group({
          id,
          status: ended ? 'ENDED' : 'ACTIVE',
          last_activity_at: at(n),
          ended_at: ended ? at(n) : null,
        })
      );
      (ended ? admin : rls).tables.submission_groups.push(...rows);
      if (ended) [E, ...ids].forEach((id) => readable.add(id));
      const seen: string[] = [];
      let cursor = '';
      for (let i = 0; i < 10; i++) {
        const body = await (
          await get(
            `?status=${status}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
          )
        ).json();
        seen.push(...body.groups.map((g: { id: string }) => g.id));
        if (!body.next_cursor) break;
        cursor = body.next_cursor;
      }
      const tiedDesc = [ids[2], ids[1], ids[0]];
      expect(seen).toEqual(
        ended ? [E, ...tiedDesc, ids[3]] : [A, A2, ...tiedDesc, ids[3]]
      );
    }
  );

  it('searches the submission ref and the contact name', async () => {
    const byRef = await (await get('?q=ref-7')).json();
    expect(byRef.groups.map((g: { id: string }) => g.id)).toEqual([A2]);
    const byName = await (await get('?q=jane')).json();
    expect(byName.groups.map((g: { id: string }) => g.id)).toEqual([A]);
    const byCompany = await (await get('?q=gulf%20star')).json();
    expect(byCompany.groups.map((g: { id: string }) => g.id)).toEqual([A2]);
    // Filter syntax in the term is a one-character wildcard, not a filter.
    const odd = await (await get('?q=EF%2C7')).json();
    expect(odd.groups.map((g: { id: string }) => g.id)).toEqual([A2]);
  });

  it('answers 400 for an unknown status or cursor', async () => {
    expect((await get('?status=open')).status).toBe(400);
    expect((await get('?cursor=yesterday')).status).toBe(400);
    expect((await get('?cursor=2026-10-10T10:00:00.000Z')).status).toBe(400);
  });

  it('lists ENDED groups sg_can_read allows, from this account only, without messages', async () => {
    as('admin');
    readable = new Set([E, X]);
    const body = await (await get('?status=ended')).json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({
      id: E,
      status: 'ENDED',
      archive: true,
      pending: false,
      contact: null,
      channel: null,
      ended_at: '2026-10-12T00:00:00.000Z',
      my_label: 'coordinator',
    });
    expect(body.groups[0]).not.toHaveProperty('messages');
  });

  it('drops an ENDED group sg_can_read refuses', async () => {
    as('team_leader');
    const body = await (await get('?status=ended')).json();
    expect(body.groups).toEqual([]);
    readable.add(E);
    const again = await (await get('?status=ended')).json();
    expect(again.groups.map((g: { id: string }) => g.id)).toEqual([E]);
  });

  it("tags each group with its case's bank, named from this account's banks", async () => {
    admin.tables.cases = [
      { account_id: 'acct-1', group_id: A, bank_code: 'FAB' },
      { account_id: 'acct-1', group_id: A2, bank_code: 'ADCB' },
    ];
    admin.tables.case_banks = [
      { account_id: 'acct-1', code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' },
      // Another workspace's name for ADCB is not this one's: A2 keeps the code.
      { account_id: 'acct-2', code: 'ADCB', name: 'Elsewhere' },
    ];
    const body = await (await get()).json();
    expect(
      body.groups.map((g: { id: string; bank: unknown }) => [g.id, g.bank])
    ).toEqual([
      [A, { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' }],
      [A2, { code: 'ADCB', name: 'ADCB' }],
    ]);
  });

  it('shows no bank for a group with no case, a case of another account, or a case without a bank', async () => {
    admin.tables.cases = [
      { account_id: 'acct-2', group_id: A, bank_code: 'FAB' },
      { account_id: 'acct-1', group_id: A2, bank_code: null },
    ];
    admin.tables.case_banks = [
      { account_id: 'acct-1', code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' },
    ];
    const body = await (await get()).json();
    expect(body.groups.map((g: { bank: unknown }) => g.bank)).toEqual([
      null,
      null,
    ]);
    // Nothing to name, so the bank list is never read.
    expect(admin.log?.some(([t]) => t === 'case_banks')).toBe(false);
  });

  it('tags an ENDED group with its bank too', async () => {
    as('admin');
    readable = new Set([E]);
    admin.tables.cases = [
      { account_id: 'acct-1', group_id: E, bank_code: 'FAB' },
    ];
    admin.tables.case_banks = [
      { account_id: 'acct-1', code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' },
    ];
    const body = await (await get('?status=ended')).json();
    expect(body.groups[0]).toMatchObject({
      id: E,
      bank: { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' },
    });
  });

  describe('?bank=', () => {
    const H = '44444444-4444-4444-8444-44444444444d';
    const A3 = '11111111-1111-4111-8111-11111111111c';
    const ids = (body: { groups: { id: string }[] }) =>
      body.groups.map((g) => g.id);

    beforeEach(() => {
      // The service role sees every ACTIVE group; RLS hands the caller only A
      // and A2 (and A3 where a test adds it), never H.
      admin.tables.submission_groups.push(
        group({ id: A }),
        group({
          id: A2,
          submission_ref: 'REF-7',
          customer_name: 'Gulf Star Trading LLC',
          contact_id: 'c2',
          last_activity_at: '2026-10-09T10:00:00.000Z',
        }),
        group({ id: H, last_activity_at: '2026-10-11T10:00:00.000Z' })
      );
      admin.tables.cases = [
        { account_id: 'acct-1', group_id: A, bank_code: 'FAB' },
        { account_id: 'acct-1', group_id: A2, bank_code: 'ADCB' },
        { account_id: 'acct-1', group_id: H, bank_code: 'FAB' },
        { account_id: 'acct-1', group_id: E, bank_code: 'FAB' },
      ];
    });

    it("lists the caller's ACTIVE groups at that bank only", async () => {
      expect(ids(await (await get('?bank=fab')).json())).toEqual([A]);
      expect(ids(await (await get('?bank=ADCB')).json())).toEqual([A2]);
      expect(ids(await (await get('?bank=HSBC')).json())).toEqual([]);
    });

    it("matches the bank on the service role, never through the caller's RLS", async () => {
      await get('?bank=FAB');
      expect(
        admin.log?.some(
          ([t, d]) => t === 'submission_groups' && d === 'cases.bank_code=FAB'
        )
      ).toBe(true);
      expect(rls.log?.some(([, d]) => d.startsWith('cases.'))).toBe(false);
    });

    it('pages a bank filter by cursor', async () => {
      const older = group({
        id: A3,
        submission_ref: 'SUB-3',
        last_activity_at: '2026-10-08T10:00:00.000Z',
      });
      admin.tables.submission_groups.push(older);
      rls.tables.submission_groups.push(older);
      admin.tables.cases.push({
        account_id: 'acct-1',
        group_id: A3,
        bank_code: 'FAB',
      });
      const first = await (await get('?bank=FAB&limit=1')).json();
      expect(ids(first)).toEqual([A]);
      expect(first.next_cursor).toEqual(expect.any(String));
      const second = await (
        await get(`?bank=FAB&limit=1&cursor=${first.next_cursor}`)
      ).json();
      expect(ids(second)).toEqual([A3]);
      expect(second.next_cursor).toBeNull();
    });

    it('combines the bank with a search', async () => {
      admin.tables.cases[1].bank_code = 'FAB';
      expect(ids(await (await get('?bank=FAB&q=gulf')).json())).toEqual([A2]);
      expect(ids(await (await get('?bank=FAB&q=jane')).json())).toEqual([A]);
    });

    it('filters ENDED groups by bank too', async () => {
      as('admin');
      readable = new Set([E]);
      expect(ids(await (await get('?status=ended&bank=FAB')).json())).toEqual([
        E,
      ]);
      expect(ids(await (await get('?status=ended&bank=ADCB')).json())).toEqual(
        []
      );
    });

    it('answers 400 for a bank that is not a code', async () => {
      expect((await get('?bank=F')).status).toBe(400);
      expect((await get('?bank=a%2Cb')).status).toBe(400);
    });
  });

  it('below admin, scans only ENDED groups the caller was on', async () => {
    as('team_leader');
    readable = new Set([E]);
    admin.tables.submission_group_access = [];
    expect((await (await get('?status=ended')).json()).groups).toEqual([]);
  });
});
