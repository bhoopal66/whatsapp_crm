import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  members: [] as { config_id: string; user_id: string }[],
  store: {
    findByRef: vi.fn(),
    listAccess: vi.fn(),
    contactConsent: vi.fn(),
    noteInvite: vi.fn(),
    get: vi.fn(),
  },
  service: { openForSubmission: vi.fn() },
  findOrCreateContact: vi.fn(),
  loadChannels: vi.fn(),
  sendInviteLink: vi.fn(),
  cases: { open: vi.fn(), get: vi.fn() },
  caseStore: vi.fn(),
}));

const db = {
  rpc: m.rpc,
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      in: async () => ({ data: m.members, error: null }),
    };
    return q;
  },
};

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    accountId: 'acct-1',
    supabase: db,
    keyId: 'key-1',
  })),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => m.store,
  submissionGroupService: () => m.service,
}));
vi.mock('@/lib/api/v1/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/contacts')>()),
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  findOrCreateContact: m.findOrCreateContact,
}));
vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/channels')>()),
  loadChannels: m.loadChannels,
}));
vi.mock('@/lib/whatsapp/groups', () => ({ sendInviteLink: m.sendInviteLink }));
vi.mock('@/lib/cases/server', () => ({ caseStore: m.caseStore }));

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/v1/submission-groups', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

const body = {
  submission_id: 'SUB-1',
  customer: { phone: '+971 50 123 4567', name: 'Jane' },
  agent_email: 'agent@x.com',
  coordinator_email: 'coord@x.com',
};

const group = (over: Partial<SubmissionGroup> = {}): SubmissionGroup =>
  ({
    id: 'g1',
    accountId: 'acct-1',
    submissionRef: 'SUB-1',
    contactId: 'c1',
    channelId: 'w1',
    subject: 'Jane · SUB-1',
    coordinatorPhone: null,
    status: 'ACTIVE',
    waGroupId: '120363000000000001@g.us',
    inviteLink: 'https://chat.whatsapp.com/CODE1',
    submissionStatus: null,
    createdAt: new Date('2026-10-16T10:00:00Z'),
    lastActivityAt: new Date('2026-10-16T10:00:00Z'),
    endedAt: null,
    endReason: null,
    waCreateError: null,
    waClosedAt: null,
    waCloseError: null,
    inviteSentAt: null,
    inviteSendError: null,
    ...over,
  }) as SubmissionGroup;

beforeEach(() => {
  vi.clearAllMocks();
  m.members = [];
  m.rpc.mockResolvedValue({
    data: [
      {
        email: 'agent@x.com',
        user_id: 'u-agent',
        role: 'agent',
        full_name: 'A',
      },
      {
        email: 'coord@x.com',
        user_id: 'u-coord',
        role: 'agent',
        full_name: 'C',
      },
    ],
    error: null,
  });
  m.store.findByRef.mockResolvedValue(null);
  m.store.listAccess.mockResolvedValue([
    { userId: 'u-agent', label: 'agent' },
    { userId: 'u-coord', label: 'coordinator' },
  ]);
  m.store.contactConsent.mockResolvedValue({
    allowed: true,
    phone: '971501234567',
  });
  m.findOrCreateContact.mockResolvedValue({ id: 'c1', created: false });
  m.loadChannels.mockResolvedValue([
    { id: 'm1', provider: 'meta', isPrimary: true },
    { id: 'w1', provider: 'whapi', isPrimary: true },
  ]);
  m.service.openForSubmission.mockResolvedValue({
    consentRequired: false,
    created: true,
    group: group(),
    inviteLink: 'https://chat.whatsapp.com/CODE1',
    refusedParticipants: [],
  });
  m.sendInviteLink.mockResolvedValue({});
  m.store.noteInvite.mockResolvedValue(true);
  m.store.get.mockResolvedValue(null);
  m.caseStore.mockReturnValue(m.cases);
  m.cases.open.mockResolvedValue({ caseId: 'case-1', created: true });
  m.cases.get.mockResolvedValue({
    id: 'case-1',
    stage: 'Submitted',
    bankCode: 'MASHREQ',
    product: 'Personal loan',
    amount: '1500.50',
  });
});

describe('POST /api/v1/submission-groups', () => {
  it('opens the group on the Whapi number with the labelled access list', async () => {
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(m.rpc).toHaveBeenCalledWith('sg_staff_by_email', {
      p_account: 'acct-1',
      p_emails: ['agent@x.com', 'coord@x.com'],
    });
    expect(m.service.openForSubmission).toHaveBeenCalledWith({
      accountId: 'acct-1',
      submissionRef: 'SUB-1',
      contactId: 'c1',
      channelId: 'w1',
      subject: 'Jane · SUB-1',
      coordinatorPhone: null,
      access: [
        { userId: 'u-agent', label: 'agent' },
        { userId: 'u-coord', label: 'coordinator' },
      ],
      keyId: 'key-1',
    });
    const { data } = await res.json();
    expect(data).toMatchObject({
      id: 'g1',
      submission_id: 'SUB-1',
      status: 'ACTIVE',
      channel_id: 'w1',
      contact_id: 'c1',
      whatsapp: {
        group_id: '120363000000000001@g.us',
        pending: false,
        invite_sent: false,
      },
      access: [
        { email: 'agent@x.com', user_id: 'u-agent', label: 'agent' },
        { email: 'coord@x.com', user_id: 'u-coord', label: 'coordinator' },
      ],
    });
    expect(m.sendInviteLink).not.toHaveBeenCalled();
    expect(m.store.noteInvite).not.toHaveBeenCalled();
    expect(data.whatsapp.invite_sent_at).toBeNull();
  });

  it('opens the case with the parsed details and returns it', async () => {
    const res = await post({
      ...body,
      bank: 'mashreq',
      product: 'Personal loan',
      amount: '1500.5',
    });
    expect(res.status).toBe(201);
    expect(m.caseStore).toHaveBeenCalledWith('acct-1');
    expect(m.cases.open).toHaveBeenCalledWith(
      'g1',
      {
        bankCode: 'MASHREQ',
        bankName: 'Mashreq',
        product: 'Personal loan',
        amount: '1500.5',
      },
      null
    );
    expect(m.cases.get).toHaveBeenCalledWith('case-1');
    expect((await res.json()).data.case).toEqual({
      id: 'case-1',
      created: true,
      stage: 'Submitted',
      bank: 'MASHREQ',
      product: 'Personal loan',
      amount: '1500.50',
    });
  });

  it('passes no bank name for an unknown bank code, and nulls for absent details', async () => {
    await post({ ...body, bank: 'NEWBANK' });
    expect(m.cases.open).toHaveBeenCalledWith(
      'g1',
      { bankCode: 'NEWBANK', bankName: null, product: null, amount: null },
      null
    );
  });

  it('still answers 201 with case null when the case cannot be opened', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.cases.open.mockRejectedValue(new Error('cases: case_open failed'));
    const res = await post({ ...body, product: 'Secret product' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.case).toBeNull();
    expect(data.id).toBe('g1');
    expect(JSON.stringify(err.mock.calls)).not.toContain('Secret product');
    err.mockRestore();
  });

  it('a 400 for a malformed case field names it and opens nothing', async () => {
    const res = await post({ ...body, amount: -1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("'amount'");
    expect(m.service.openForSubmission).not.toHaveBeenCalled();
    expect(m.cases.open).not.toHaveBeenCalled();
  });

  it('refuses a bad body with 400 and opens nothing', async () => {
    const res = await post({ ...body, submission_id: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(m.service.openForSubmission).not.toHaveBeenCalled();
  });

  it('names an unknown staff email with 422 unknown_user', async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          email: 'agent@x.com',
          user_id: 'u-agent',
          role: 'agent',
          full_name: null,
        },
      ],
      error: null,
    });
    const res = await post(body);
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe('unknown_user');
    expect(error.message).toContain('coordinator_email');
    expect(m.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('refuses the same person under two labels', async () => {
    const res = await post({ ...body, coordinator_email: 'AGENT@x.com' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('duplicate_user');
  });

  it.each(['opted_out', 'do_not_contact'] as const)(
    'refuses a %s customer with 409 consent_required',
    async (reason) => {
      m.store.contactConsent.mockResolvedValue({
        allowed: false,
        phone: '971501234567',
        reason,
      });
      const res = await post(body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('consent_required');
      expect(m.service.openForSubmission).not.toHaveBeenCalled();
    }
  );

  it('creates the contact with the customer name when absent', async () => {
    await post(body);
    expect(m.findOrCreateContact).toHaveBeenCalledWith(
      db,
      'acct-1',
      'owner-1',
      { phone: '971501234567', name: 'Jane' }
    );
  });

  it('answers 422 no_whapi_number when only a Meta number is connected', async () => {
    m.loadChannels.mockResolvedValue([
      { id: 'm1', provider: 'meta', isPrimary: true },
    ]);
    const res = await post(body);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no_whapi_number');
    expect(m.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('answers 422 channel_not_allowed for a number allocated to someone else', async () => {
    m.members = [{ config_id: 'w1', user_id: 'u-other' }];
    const res = await post({
      ...body,
      channel_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('channel_not_allowed');
    expect(m.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('returns an existing group (200) without re-resolving staff', async () => {
    m.store.findByRef.mockResolvedValue(group());
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: false,
      group: group(),
      inviteLink: group().inviteLink,
      refusedParticipants: [],
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.service.openForSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ submissionRef: 'SUB-1', channelId: 'w1' })
    );
  });

  it('a repeat call (200) fills the case through open() and returns it', async () => {
    m.store.findByRef.mockResolvedValue(group());
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: false,
      group: group(),
      inviteLink: group().inviteLink,
      refusedParticipants: [],
    });
    m.cases.open.mockResolvedValue({ caseId: 'case-1', created: false });
    const res = await post({ ...body, amount: 1500.5 });
    expect(res.status).toBe(200);
    expect(m.cases.open).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ amount: '1500.5' }),
      null
    );
    expect((await res.json()).data.case).toMatchObject({
      id: 'case-1',
      created: false,
    });
  });

  it('sends the invite link to a customer WhatsApp refused', async () => {
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: true,
      group: group(),
      inviteLink: 'https://chat.whatsapp.com/CODE1',
      refusedParticipants: ['971501234567'],
    });
    m.store.get.mockResolvedValue(
      group({ inviteSentAt: new Date('2026-10-16T10:01:00Z') })
    );
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(m.sendInviteLink).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteCode: 'CODE1',
        to: '971501234567',
        channel: expect.objectContaining({ id: 'w1' }),
      })
    );
    expect(m.store.noteInvite).toHaveBeenCalledWith('g1', true, null);
    const { data } = await res.json();
    expect(data.whatsapp).toMatchObject({
      invite_sent: true,
      invite_sent_at: '2026-10-16T10:01:00.000Z',
      refused_participants: ['971501234567'],
    });
  });

  it('answers 201 even when recording the invite fails', async () => {
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: true,
      group: group(),
      inviteLink: 'https://chat.whatsapp.com/CODE1',
      refusedParticipants: ['971501234567'],
    });
    m.store.noteInvite.mockRejectedValue(new Error('db down'));
    const res = await post(body);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.whatsapp).toMatchObject({
      invite_sent: true,
      invite_sent_at: null,
    });
  });

  it('reports invite_sent false when the invite send fails', async () => {
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: true,
      group: group(),
      inviteLink: 'https://chat.whatsapp.com/CODE1',
      refusedParticipants: ['971501234567@s.whatsapp.net'],
    });
    m.sendInviteLink.mockRejectedValue(new Error('gateway down: secret'));
    const res = await post(body);
    expect(res.status).toBe(201);
    expect((await res.json()).data.whatsapp.invite_sent).toBe(false);
    expect(m.store.noteInvite).toHaveBeenCalledWith(
      'g1',
      false,
      'The invite could not be sent'
    );
  });

  it('records a fixed category, never the gateway text, when WhatsApp refuses the invite', async () => {
    m.service.openForSubmission.mockResolvedValue({
      consentRequired: false,
      created: true,
      group: group(),
      inviteLink: 'https://chat.whatsapp.com/CODE1',
      refusedParticipants: ['971501234567'],
    });
    m.sendInviteLink.mockRejectedValue(
      Object.assign(new Error('HTTP 403: token abc123 refused'), {
        status: 403,
      })
    );
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(m.store.noteInvite).toHaveBeenCalledWith(
      'g1',
      false,
      'WhatsApp refused the invite'
    );
  });

  it('answers 202 pending, never 5xx, when WhatsApp cannot create the group', async () => {
    m.service.openForSubmission.mockRejectedValue(
      new Error('whapi 500: internal secret wording')
    );
    m.store.findByRef
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(group({ waGroupId: null, inviteLink: null }));
    const res = await post(body);
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).not.toContain('secret wording');
    expect(JSON.parse(text).data.whatsapp).toMatchObject({
      pending: true,
      group_id: null,
      error: expect.any(String),
    });
    expect(m.cases.open).toHaveBeenCalledWith('g1', expect.any(Object), null);
    expect(JSON.parse(text).data.case).toMatchObject({ id: 'case-1' });
  });

  it('answers a generic 500 when no row was written', async () => {
    m.service.openForSubmission.mockRejectedValue(new Error('db down: detail'));
    const res = await post(body);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('detail');
  });
});
