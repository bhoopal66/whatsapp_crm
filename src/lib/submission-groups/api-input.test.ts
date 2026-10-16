import { describe, expect, it } from 'vitest';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  chooseHostingNumber,
  defaultSubject,
  inviteCodeOf,
  parseCreateInput,
  parsePatchInput,
  phoneWasRefused,
  resolveStaff,
  serializeGroup,
} from './api-input';
import type { SubmissionGroup } from './store';

const base = {
  submission_id: ' SUB-1 ',
  customer: { phone: '+971 50 123 4567', name: 'Jane' },
  agent_email: ' Agent@Example.com ',
};

describe('parseCreateInput', () => {
  it('normalises the minimal body and defaults the subject', () => {
    const r = parseCreateInput(base);
    expect(r).toEqual({
      ok: true,
      value: {
        submissionId: 'SUB-1',
        customerPhone: '971501234567',
        customerName: 'Jane',
        staff: [
          { field: 'agent_email', email: 'agent@example.com', label: 'agent' },
        ],
        coordinatorPhone: null,
        subject: 'Jane · SUB-1',
        channelId: null,
      },
    });
  });

  it('keeps optional staff, coordinator phone, subject and channel', () => {
    const r = parseCreateInput({
      ...base,
      coordinator_email: 'c@example.com',
      team_lead_email: 'l@example.com',
      coordinator_phone: '+971 55 765 4321',
      subject: '  Case 1 ',
      channel_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.staff.map((s) => s.label)).toEqual([
      'agent',
      'coordinator',
      'team_lead',
    ]);
    expect(r.value.coordinatorPhone).toBe('971557654321');
    expect(r.value.subject).toBe('Case 1');
    expect(r.value.channelId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it.each([
    [null, /JSON object/],
    [{ ...base, submission_id: '   ' }, /submission_id/],
    [{ ...base, submission_id: 'x'.repeat(129) }, /submission_id/],
    [{ ...base, customer: undefined }, /'customer' is required/],
    [{ ...base, customer: { name: 'x' } }, /customer.phone/],
    [{ ...base, customer: { phone: '0501234567' } }, /country code/],
    [
      { ...base, customer: { phone: '+971501234567', name: 'x'.repeat(201) } },
      /customer.name/,
    ],
    [{ ...base, agent_email: undefined }, /'agent_email' is required/],
    [{ ...base, coordinator_email: 'nope' }, /coordinator_email/],
    [{ ...base, subject: 'x'.repeat(101) }, /subject/],
    [{ ...base, channel_id: 'not-a-uuid' }, /channel_id/],
    [{ ...base, coordinator_phone: 12 }, /coordinator_phone/],
  ])('refuses %j', (body, message) => {
    const r = parseCreateInput(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });

  it('cuts the default subject to 100 characters, phone when no name', () => {
    expect(defaultSubject(null, '971501234567', 'S')).toBe('971501234567 · S');
    expect(defaultSubject('n'.repeat(120), 'p', 'S')).toHaveLength(100);
  });
});

describe('parsePatchInput', () => {
  it('trims the status and bounds it to 1–64 characters', () => {
    expect(parsePatchInput({ status: ' APPROVED ' })).toEqual({
      ok: true,
      value: { status: 'APPROVED' },
    });
    expect(parsePatchInput({ status: ' ' }).ok).toBe(false);
    expect(parsePatchInput({ status: 'x'.repeat(65) }).ok).toBe(false);
    expect(parsePatchInput({}).ok).toBe(false);
  });
});

describe('resolveStaff', () => {
  const req = [
    {
      field: 'agent_email' as const,
      email: 'a@x.com',
      label: 'agent' as const,
    },
    {
      field: 'coordinator_email' as const,
      email: 'c@x.com',
      label: 'coordinator' as const,
    },
  ];
  const row = (email: string, user_id: string) => ({
    email,
    user_id,
    role: 'agent',
    full_name: null,
  });

  it('maps each email to its person and label', () => {
    const r = resolveStaff(req, [row('c@x.com', 'u2'), row('A@X.com', 'u1')]);
    expect(r).toEqual({
      ok: true,
      staff: [
        { userId: 'u1', email: 'a@x.com', label: 'agent', role: 'agent' },
        { userId: 'u2', email: 'c@x.com', label: 'coordinator', role: 'agent' },
      ],
    });
  });

  it('names the field of an unknown or ineligible email', () => {
    expect(resolveStaff(req, [row('a@x.com', 'u1')])).toEqual({
      ok: false,
      code: 'unknown_user',
      field: 'coordinator_email',
    });
  });

  it('refuses one person under two labels', () => {
    expect(
      resolveStaff(
        [req[0], { ...req[1], email: 'a@x.com' }],
        [row('a@x.com', 'u1')]
      )
    ).toEqual({
      ok: false,
      code: 'duplicate_user',
      fields: ['agent_email', 'coordinator_email'],
    });
  });
});

const ch = (id: string, provider: 'whapi' | 'meta', isPrimary = false) =>
  ({ id, provider, isPrimary, accountId: 'a' }) as WhatsAppChannel;

describe('chooseHostingNumber', () => {
  const channels = [
    ch('m1', 'meta', true),
    ch('w1', 'whapi', true),
    ch('w2', 'whapi'),
  ];
  const pick = (over: Partial<Parameters<typeof chooseHostingNumber>[0]>) =>
    chooseHostingNumber({
      channels,
      members: [],
      agentUserId: 'u1',
      agentRole: 'agent',
      requestedId: null,
      ...over,
    });

  it('refuses a workspace with no Whapi number', () => {
    expect(pick({ channels: [ch('m1', 'meta', true)] })).toEqual({
      ok: false,
      code: 'no_whapi_number',
    });
  });

  it('picks the primary Whapi number when every number is shared', () => {
    expect(pick({})).toMatchObject({ ok: true, channel: { id: 'w1' } });
  });

  it("picks the agent's allocated number", () => {
    const r = pick({ members: [{ config_id: 'w2', user_id: 'u1' }] });
    expect(r).toMatchObject({ ok: true, channel: { id: 'w2' } });
  });

  it("avoids someone else's number for an unallocated agent", () => {
    const r = pick({ members: [{ config_id: 'w1', user_id: 'u9' }] });
    expect(r).toMatchObject({ ok: true, channel: { id: 'w2' } });
  });

  it('refuses when every Whapi number belongs to other people', () => {
    const members = [
      { config_id: 'w1', user_id: 'u9' },
      { config_id: 'w2', user_id: 'u9' },
    ];
    expect(pick({ members })).toEqual({
      ok: false,
      code: 'channel_not_allowed',
    });
    expect(pick({ members, agentRole: 'admin' })).toMatchObject({
      ok: true,
      channel: { id: 'w1' },
    });
  });

  it('checks a requested number: Whapi, of the workspace, usable by the agent', () => {
    const members = [{ config_id: 'w2', user_id: 'u9' }];
    expect(pick({ requestedId: 'w2', members })).toEqual({
      ok: false,
      code: 'channel_not_allowed',
    });
    expect(pick({ requestedId: 'm1' })).toEqual({
      ok: false,
      code: 'channel_not_allowed',
    });
    expect(pick({ requestedId: 'zz' })).toEqual({
      ok: false,
      code: 'channel_not_allowed',
    });
    expect(pick({ requestedId: 'w2' })).toMatchObject({
      ok: true,
      channel: { id: 'w2' },
    });
    expect(
      pick({ requestedId: 'w2', members, agentRole: 'owner' })
    ).toMatchObject({
      ok: true,
      channel: { id: 'w2' },
    });
  });
});

describe('phoneWasRefused / inviteCodeOf', () => {
  it('matches wa ids and JIDs by digits', () => {
    expect(
      phoneWasRefused(['971501234567@s.whatsapp.net'], '971501234567')
    ).toBe(true);
    expect(phoneWasRefused(['971501234567'], '+971 50 123 4567')).toBe(true);
    expect(phoneWasRefused(['971509999999'], '971501234567')).toBe(false);
    expect(phoneWasRefused([], '971501234567')).toBe(false);
  });

  it('reads the code of a chat.whatsapp.com link only', () => {
    expect(inviteCodeOf('https://chat.whatsapp.com/AbC123')).toBe('AbC123');
    expect(inviteCodeOf('https://evil.example/AbC123')).toBeNull();
    expect(inviteCodeOf(null)).toBeNull();
  });
});

describe('serializeGroup', () => {
  const group = {
    id: 'g1',
    submissionRef: 'SUB-1',
    status: 'ACTIVE',
    submissionStatus: null,
    channelId: 'w1',
    contactId: 'c1',
    waGroupId: null,
    inviteLink: null,
    createdAt: new Date('2026-10-16T10:00:00Z'),
    endedAt: null,
  } as unknown as SubmissionGroup;

  it('marks a group without a WhatsApp group pending and keeps emails when known', () => {
    const out = serializeGroup(
      group,
      [
        { userId: 'u1', label: 'agent', email: 'a@x.com' },
        { userId: 'u2', label: 'coordinator' },
      ],
      { error: 'later' }
    );
    expect(out.whatsapp).toEqual({
      group_id: null,
      invite_link: null,
      pending: true,
      refused_participants: [],
      invite_sent: false,
      invite_sent_at: null,
      error: 'later',
    });
    expect(out.access).toEqual([
      { email: 'a@x.com', user_id: 'u1', label: 'agent' },
      { user_id: 'u2', label: 'coordinator' },
    ]);
    expect(out.created_at).toBe('2026-10-16T10:00:00.000Z');
  });

  it('is not pending once ENDED', () => {
    const ended = {
      ...group,
      status: 'ENDED',
      endedAt: new Date('2026-10-17T00:00:00Z'),
    };
    const out = serializeGroup(ended as SubmissionGroup, []);
    expect(out.whatsapp.pending).toBe(false);
    expect(out.ended_at).toBe('2026-10-17T00:00:00.000Z');
  });

  it('carries when the 1:1 invite link went out (118)', () => {
    const sent = { ...group, inviteSentAt: new Date('2026-10-16T10:01:00Z') };
    const out = serializeGroup(sent as SubmissionGroup, []);
    expect(out.whatsapp.invite_sent_at).toBe('2026-10-16T10:01:00.000Z');
  });
});
