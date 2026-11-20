import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AutoMsgRpcError, PgAutoMsgStore } from './store';
import { DEFAULT_SETTINGS } from './types';

type Result = { data: unknown; error: unknown };

function rig(result: Result = { data: null, error: null }) {
  const rpc = vi.fn<(fn: string, args: unknown) => Promise<Result>>(
    async () => result
  );
  const store = new PgAutoMsgStore({ rpc } as unknown as SupabaseClient);
  return { rpc, store };
}

const ROW = {
  id: 'r1',
  account_id: 'acc-1',
  conversation_id: 'conv-1',
  contact_id: 'contact-1',
  trigger: 'stage_hr_interview',
  template_kind: 'hr_interview_invite',
  language: 'en',
  params: { name: 'Sara', slot: 'Monday', bad: 3 },
  body_rendered: null,
  dedupe_key: 'k1',
  status: 'pending',
  hold_reason: null,
  attempts: 1,
  claim_state: null,
  created_at: '2026-11-16T08:00:00Z',
  sent_at: null,
};

const STATE = {
  row: ROW,
  closed: false,
  inbox: 'recruiter',
  personal: false,
  opted_out: false,
  consent: true,
  last_inbound_at: '2026-11-16T07:00:00Z',
  contact_name: 'Sara',
  settings: {
    kill_switch: false,
    quiet_start: '22:30',
    quiet_end: '07:15',
    tz: 'Asia/Dubai',
    requires_consent: true,
    daily_cap: 5,
  },
  trigger_enabled: true,
  template: {
    kind: 'hr_interview_invite',
    language: 'en',
    body: 'Hi {name}, {slot}',
    meta_template_name: 'hr_hr_interview_invite',
    approval_status: 'approved',
    category: 'utility',
  },
  sent_today: 2,
};

describe('PgAutoMsgStore.state', () => {
  it('maps hr_automsg_row_state jsonb to RowState', async () => {
    const { rpc, store } = rig({ data: STATE, error: null });
    const s = await store.state('r1');
    expect(rpc).toHaveBeenCalledWith('hr_automsg_row_state', { p_id: 'r1' });
    expect(s).toEqual({
      row: {
        id: 'r1',
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        trigger: 'stage_hr_interview',
        templateKind: 'hr_interview_invite',
        language: 'en',
        params: { name: 'Sara', slot: 'Monday' },
        bodyRendered: null,
        dedupeKey: 'k1',
        status: 'pending',
        holdReason: null,
        attempts: 1,
        claimState: null,
        createdAt: '2026-11-16T08:00:00Z',
        sentAt: null,
      },
      closed: false,
      inbox: 'recruiter',
      personal: false,
      optedOut: false,
      consent: true,
      lastInboundAt: '2026-11-16T07:00:00Z',
      contactName: 'Sara',
      settings: {
        killSwitch: false,
        quietStart: '22:30',
        quietEnd: '07:15',
        tz: 'Asia/Dubai',
        requiresConsent: true,
        dailyCap: 5,
        triggers: {
          stage_hr_interview: {
            enabled: true,
            templateKind: 'hr_interview_invite',
          },
        },
      },
      triggerEnabled: true,
      template: {
        kind: 'hr_interview_invite',
        language: 'en',
        body: 'Hi {name}, {slot}',
        metaTemplateName: 'hr_hr_interview_invite',
        approvalStatus: 'approved',
        category: 'utility',
      },
      sentToday: 2,
      channel: 'whatsapp',
    });
  });

  it('carries migration 215 channel; an unknown one throws', async () => {
    const rcs = rig({ data: { ...STATE, channel: 'rcs' }, error: null });
    expect((await rcs.store.state('r1'))?.channel).toBe('rcs');
    const bad = rig({ data: { ...STATE, channel: 'sms' }, error: null });
    await expect(bad.store.state('r1')).rejects.toThrow(/channel sms/);
  });

  it('reads the row’s own channel when the state has none (203 re-run after 215)', async () => {
    const { store } = rig({
      data: { ...STATE, row: { ...ROW, channel: 'rcs' } },
      error: null,
    });
    expect((await store.state('r1'))?.channel).toBe('rcs');
  });

  it('a state and row that disagree on the channel throw', async () => {
    const { store } = rig({
      data: { ...STATE, channel: 'whatsapp', row: { ...ROW, channel: 'rcs' } },
      error: null,
    });
    await expect(store.state('r1')).rejects.toThrow(/channel disagrees/);
  });

  it('the trigger switch comes from trigger_enabled', async () => {
    const { store } = rig({
      data: { ...STATE, trigger_enabled: false },
      error: null,
    });
    const s = await store.state('r1');
    expect(s?.triggerEnabled).toBe(false);
    expect(s?.settings.triggers.stage_hr_interview?.enabled).toBe(false);
  });

  it('a null state is null', async () => {
    const { store } = rig({ data: null, error: null });
    expect(await store.state('r1')).toBeNull();
  });

  it('missing closed is closed (fail safe); missing settings keys use the defaults', async () => {
    const rest: Record<string, unknown> = { ...STATE };
    delete rest.closed;
    delete rest.settings;
    const { store } = rig({ data: rest, error: null });
    const s = await store.state('r1');
    expect(s?.closed).toBe(true);
    expect(s?.settings).toMatchObject({
      killSwitch: DEFAULT_SETTINGS.killSwitch,
      quietStart: DEFAULT_SETTINGS.quietStart,
      quietEnd: DEFAULT_SETTINGS.quietEnd,
      tz: DEFAULT_SETTINGS.tz,
      requiresConsent: DEFAULT_SETTINGS.requiresConsent,
      dailyCap: DEFAULT_SETTINGS.dailyCap,
    });
  });
});

describe('PgAutoMsgStore writes', () => {
  const NOW = new Date('2026-11-16T09:00:00Z');

  it.each([
    ['claimed', 'claimed'],
    ['capped', 'capped'],
    ['lost', 'lost'],
    [null, 'lost'],
  ] as const)('claim %s -> %s', async (data, outcome) => {
    const { rpc, store } = rig({ data, error: null });
    expect(await store.claim('r1', NOW)).toBe(outcome);
    expect(rpc).toHaveBeenCalledWith('hr_automsg_claim', {
      p_id: 'r1',
      p_now: '2026-11-16T09:00:00.000Z',
    });
  });

  it('mark: held, cancelled, sent, failed', async () => {
    const { rpc, store } = rig();
    await store.hold('r1', 'quiet_hours');
    await store.cancel('r1');
    await store.markSent('r1', {
      providerMessageId: 'wamid-1',
      messageId: 'm-1',
      bodyRendered: 'Hi Sara',
    });
    await store.markFailed('r1', 'boom');
    expect(rpc.mock.calls).toEqual([
      [
        'hr_automsg_mark',
        { p_id: 'r1', p_status: 'held', p_hold_reason: 'quiet_hours' },
      ],
      ['hr_automsg_mark', { p_id: 'r1', p_status: 'cancelled' }],
      [
        'hr_automsg_mark',
        {
          p_id: 'r1',
          p_status: 'sent',
          p_provider_message_id: 'wamid-1',
          p_message_id: 'm-1',
          p_body_rendered: 'Hi Sara',
        },
      ],
      ['hr_automsg_mark', { p_id: 'r1', p_status: 'failed', p_error: 'boom' }],
    ]);
  });

  it('settleUnconfirmed passes the provider message id', async () => {
    const { rpc, store } = rig();
    await store.settleUnconfirmed('r1', 'wamid-1');
    expect(rpc).toHaveBeenCalledWith('hr_automsg_settle_unconfirmed', {
      p_id: 'r1',
      p_provider_message_id: 'wamid-1',
    });
  });

  it('an RPC refusal surfaces its HINT and SQLSTATE', async () => {
    const { store } = rig({
      data: null,
      error: {
        message: 'already decided',
        hint: 'ALREADY_DECIDED',
        code: 'P0001',
      },
    });
    const err = await store
      .markSent('r1', {
        providerMessageId: null,
        messageId: null,
        bodyRendered: 'x',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoMsgRpcError);
    expect(err).toMatchObject({
      hint: 'ALREADY_DECIDED',
      code: 'P0001',
      message: 'already decided',
    });
  });
});
