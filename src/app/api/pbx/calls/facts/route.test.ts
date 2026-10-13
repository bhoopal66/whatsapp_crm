import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import { parseCallFacts } from '@/lib/pbx/call-facts';
import { consentText } from '@/lib/pbx/call-ui';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', () => ({ pbxServiceDb: () => mocks.service }));

import { GET } from './route';

const CONN = '00000000-0000-4000-8000-0000000000c1';
const SEEN = '00000000-0000-4000-8000-000000000001';
const HIDDEN = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const LABELS = {
  callsOk: 'Calls OK',
  doNotContact: 'Do not contact',
  optedOut: 'Opted out',
  unknown: 'Unknown',
  marketingOn: 'marketing on',
  marketingOff: 'marketing off',
};
let rls: FakeDb;
let service: FakeDb;

const contacts = [
  { id: SEEN, account_id: 'a', name: 'Sara', company: 'Acme', user_id: 'u' },
  {
    id: HIDDEN,
    account_id: 'a',
    name: 'Omar',
    company: 'Secret Co',
    phone: '971500000000',
    user_id: 'rm',
    do_not_contact_at: '2026-10-01T00:00:00Z',
    do_not_contact_reason: 'Asked not to be called',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The caller's own reads (RLS) see SEEN only.
  rls = createFakeDb({
    contacts: contacts.filter((c) => c.id === SEEN),
    deals: [{ contact_id: SEEN, status: 'open', title: 'Loan' }],
    conversations: [],
  });
  service = createFakeDb({
    call_live: [
      {
        connection_id: CONN,
        pbx_call_id: 'p1',
        account_id: 'a',
        contact_id: HIDDEN,
        ringing_user_ids: ['me'],
        answered_by: null,
        members: [],
      },
      {
        connection_id: CONN,
        pbx_call_id: 'p2',
        account_id: 'a',
        contact_id: null,
        ringing_user_ids: ['me'],
        answered_by: null,
        members: [{ kind: 'inbound', contactCandidates: [SEEN, HIDDEN] }],
      },
      {
        connection_id: CONN,
        pbx_call_id: 'p3',
        account_id: 'b',
        contact_id: HIDDEN,
        ringing_user_ids: ['me'],
        answered_by: null,
        members: [],
      },
    ],
    contacts,
    profiles: [
      { account_id: 'a', user_id: 'rm', full_name: 'Rania' },
      { account_id: 'b', user_id: 'rm', full_name: 'Other workspace' },
    ],
  });
  mocks.service = service.db;
  mocks.requireRole.mockResolvedValue({
    accountId: 'a',
    userId: 'me',
    role: 'agent',
    supabase: rls.db,
  });
});

const get = (q: Record<string, string>) =>
  GET(
    new Request(
      `https://crm.example.com/api/pbx/calls/facts?${new URLSearchParams({
        connectionId: CONN,
        ...q,
      })}`
    )
  );

describe('GET /api/pbx/calls/facts', () => {
  it('never reads a hidden do-not-contact customer as "Calls OK"', async () => {
    const res = await get({ pbxCallId: 'p1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const facts = parseCallFacts(body);
    expect(facts).toMatchObject({
      hidden: true,
      name: 'Omar',
      ownerId: 'rm',
      ownerName: 'Rania',
    });
    const line = consentText(facts!, LABELS);
    expect(line).toBe('Do not contact · marketing off');
    expect(line).not.toContain('Calls OK');
    // Only what taking the call needs: no reason, company, number, deal or chat.
    expect(body.do_not_contact_reason).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Asked not to be called');
    expect(body.company).toBeNull();
    expect(body.phone).toBeNull();
    expect(body.deal).toBeNull();
    expect(body.last).toBeNull();
    expect(body.conversationId).toBeNull();
  });

  it('gives the full facts, through the caller’s own reads, when they see the contact', async () => {
    const res = await get({ pbxCallId: 'p2', contactId: SEEN });
    expect(await res.json()).toMatchObject({
      hidden: false,
      name: 'Sara',
      company: 'Acme',
      deal: 'Loan',
    });
  });

  it('answers only a ringing or answering party', async () => {
    mocks.requireRole.mockResolvedValue({
      accountId: 'a',
      userId: 'leader',
      role: 'team_leader',
      supabase: rls.db,
    });
    const res = await get({ pbxCallId: 'p1' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_on_call');
  });

  it('never reads another workspace’s live call', async () => {
    expect((await get({ pbxCallId: 'p3' })).status).toBe(404);
  });

  it('never lists a hidden candidate of the number, only the call’s own match', async () => {
    // p2 matched no one; its number's candidates are SEEN and HIDDEN.
    const res = await get({ pbxCallId: 'p2', contactId: HIDDEN });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/Omar|Rania|rm/);
  });

  it('only for the call’s own contact or its number’s candidates', async () => {
    expect((await get({ pbxCallId: 'p1', contactId: OTHER })).status).toBe(404);
    expect((await get({ pbxCallId: 'p1', contactId: 'x' })).status).toBe(400);
    expect((await get({ pbxCallId: 'p2' })).status).toBe(404);
  });
});
