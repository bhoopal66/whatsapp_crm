import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  channel: {} as Record<string, unknown>,
  row: null as Record<string, unknown> | null,
  sendTemplate: vi.fn(),
  resolveSendChannel: vi.fn(),
  definite: true,
}));

vi.mock('@/lib/whatsapp/channels', () => ({
  resolveSendChannel: h.resolveSendChannel,
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendTemplate: h.sendTemplate,
  isDefiniteSendRefusal: () => h.definite,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  renderTemplateBody: (b: string, p: string[]) =>
    b.replace('{{1}}', p[0]).replace('{{2}}', p[1]),
  resolveTemplateRow: async () => ({ row: h.row }),
}));

import { createFakeDb, type FakeDb } from './__tests__/fake-db';
import type { FinishedCall } from './service-details';
import {
  sendCallServiceDetails,
  serviceDetailsPorts,
} from './service-details-store';

const A = 'acc';
const CALL: FinishedCall = {
  callRowId: 'call-row',
  accountId: A,
  direction: 'inbound',
  answered: true,
  agentExtension: '1001',
  agentKnown: true,
  talkSeconds: 60,
  customerNumber: '+971501234567',
  queue: null,
  did: '80012',
};
const SEND = {
  accountId: A,
  contactId: 'k1',
  phone: '+971501234567',
  templateName: 'call_details',
  language: 'en',
  params: ['Ahmed', 'Car loans'] as [string, string],
};
let fake: FakeDb;
let claimAnswer: string;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.channel = { id: 'n1', provider: 'meta', isPersonal: false };
  h.row = {
    name: 'call_details',
    status: 'APPROVED',
    category: 'UTILITY',
    body_text: 'Hi {{1}}, about {{2}}',
  };
  h.definite = true;
  h.resolveSendChannel.mockReset().mockImplementation(async () => h.channel);
  h.sendTemplate.mockReset().mockResolvedValue({ messageId: 'wamid.1' });
  claimAnswer = 'claimed';
  fake = createFakeDb(
    {
      pbx_service_details_settings: [
        {
          account_id: A,
          enabled: true,
          template_name: 'call_details',
          language: 'en',
          min_seconds: 20,
          inbound: true,
          outbound: false,
        },
      ],
      pbx_service_map: [
        {
          account_id: A,
          match_type: 'did',
          match_value: '80012',
          label: 'Car loans',
        },
      ],
      contacts: [
        {
          id: 'k1',
          account_id: A,
          name: 'Ahmed',
          phone_normalized: '0501234567',
          opted_out_at: null,
          do_not_contact_at: null,
        },
        {
          id: 'k9',
          account_id: 'other',
          name: 'X',
          phone_normalized: '971501234567',
        },
      ],
      conversations: [
        {
          id: 'v-personal',
          account_id: A,
          contact_id: 'k1',
          personal_owner_id: 'u1',
          channel_id: 'n2',
          created_at: '2026-11-02',
        },
        {
          id: 'v1',
          account_id: A,
          contact_id: 'k1',
          personal_owner_id: null,
          channel_id: 'n1',
          send_channel_id: null,
          created_at: '2026-11-01',
        },
      ],
      messages: [],
    },
    {
      pbx_service_details_claim: () => ({ data: claimAnswer, error: null }),
      pbx_service_details_settle: () => ({ data: true, error: null }),
    }
  );
});

describe('service details store', () => {
  it('sends the template on the company chat and records it there', async () => {
    expect(await sendCallServiceDetails(fake.db, CALL)).toBe('sent');
    expect(h.resolveSendChannel).toHaveBeenCalledWith(
      fake.db,
      A,
      'inbox',
      'v1',
      null,
      null,
      { channelId: 'n1', sendChannelId: null, personalOwnerId: null }
    );
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '971501234567',
        bodyParams: ['Ahmed', 'Car loans'],
      })
    );
    expect(fake.tables.messages).toEqual([
      expect.objectContaining({
        conversation_id: 'v1',
        sender_type: 'bot',
        content_type: 'template',
        content_text: 'Hi Ahmed, about Car loans',
        template_name: 'call_details',
        message_id: 'wamid.1',
        status: 'sent',
        channel_id: 'n1',
      }),
    ]);
    expect(fake.log.filter((l) => l.op === 'rpc')).toEqual([
      {
        table: 'rpc:pbx_service_details_claim',
        op: 'rpc',
        payload: {
          p_account: A,
          p_call: 'call-row',
          p_outcome: 'sending',
          p_contact: 'k1',
        },
      },
      {
        table: 'rpc:pbx_service_details_settle',
        op: 'rpc',
        payload: { p_account: A, p_call: 'call-row', p_outcome: 'sent' },
      },
    ]);
  });

  it('finds only the account’s contacts, by every stored form of the number', async () => {
    const hits = await serviceDetailsPorts(fake.db).findContacts(
      A,
      '+971501234567'
    );
    expect(hits).toEqual([
      { id: 'k1', name: 'Ahmed', optedOutAt: null, doNotContactAt: null },
    ]);
  });

  it('a workspace with no settings row is switched off', async () => {
    fake.tables.pbx_service_details_settings = [];
    const s = await serviceDetailsPorts(fake.db).loadSettings(A);
    expect(s.enabled).toBe(false);
  });

  it.each([
    ['opted_out', 'duplicate'],
    ['duplicate', 'duplicate'],
    ['daily_cap', 'daily_cap'],
    ['claimed', 'claimed'],
  ])('a claim answered %s is %s', async (answer, port) => {
    claimAnswer = answer;
    expect(
      await serviceDetailsPorts(fake.db).claim(CALL, 'sending', 'k1')
    ).toBe(port);
  });

  it('a STOP since the lookup sends nothing', async () => {
    claimAnswer = 'opted_out';
    expect(await sendCallServiceDetails(fake.db, CALL)).toBe('duplicate');
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('sends nothing off Meta, without a company chat, or without an approved utility template', async () => {
    const ports = serviceDetailsPorts(fake.db);
    h.channel = { id: 'n1', provider: 'whapi', isPersonal: false };
    expect(await ports.send(SEND)).toBe(false);
    h.channel = { id: 'n1', provider: 'meta', isPersonal: false };
    h.row = { status: 'APPROVED', category: 'MARKETING', body_text: '' };
    expect(await ports.send(SEND)).toBe(false);
    h.row = { status: 'PENDING', category: 'UTILITY', body_text: '' };
    expect(await ports.send(SEND)).toBe(false);
    h.row = null;
    expect(await ports.send(SEND)).toBe(false);
    fake.tables.conversations = fake.tables.conversations.filter(
      (c) => c.personal_owner_id
    );
    expect(await ports.send(SEND)).toBe(false);
    expect(h.sendTemplate).not.toHaveBeenCalled();
    expect(fake.tables.messages).toEqual([]);
  });

  it('tries the next form after a recipient refusal; any other refusal fails', async () => {
    const ports = serviceDetailsPorts(fake.db);
    h.sendTemplate
      .mockRejectedValueOnce(
        new Error('(#131030) Recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.2' });
    expect(await ports.send(SEND)).toBe(true);
    expect(h.sendTemplate).toHaveBeenCalledTimes(2);
    h.sendTemplate.mockReset().mockRejectedValue(new Error('template paused'));
    expect(await ports.send(SEND)).toBe(false);
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed send is never retried and shows as still sending', async () => {
    h.definite = false;
    h.sendTemplate.mockRejectedValue(new Error('timeout'));
    expect(await serviceDetailsPorts(fake.db).send(SEND)).toBe(true);
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(fake.tables.messages).toEqual([
      expect.objectContaining({ status: 'sending', message_id: null }),
    ]);
  });

  it('a failed read or RPC is an error, never a send', async () => {
    fake.fail('pbx_service_details_settings', 'select', {
      message: 'x',
      code: '57014',
    });
    expect(await sendCallServiceDetails(fake.db, CALL)).toBe('error');
    delete fake.rpcs.pbx_service_details_claim;
    expect(await sendCallServiceDetails(fake.db, CALL)).toBe('error');
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });
});
