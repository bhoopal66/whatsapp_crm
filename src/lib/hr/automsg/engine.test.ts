import { describe, expect, it, vi } from 'vitest';
import { assertTemplateOnly, processDue, processRow } from './engine';
import { MetaError } from '@/lib/whatsapp/meta-api';
import { HrSendRefusal } from './failure';
import { MemoryAutoMsgStore, type MemoryContext } from './memory-store';
import type { EngineDeps, SendPort, TemplateSendRequest } from './ports';
import { SEED_TEMPLATES, SLOT_FALLBACK } from './templates';
import { DEFAULT_SETTINGS, type OutboxRow } from './types';

const NOW = new Date('2026-11-14T10:00:00Z'); // 14:00 Dubai

function row(id: string, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id,
    accountId: 'acc',
    conversationId: 'c1',
    contactId: 'p1',
    trigger: 'stage_hr_interview',
    templateKind: 'hr_interview_invite',
    language: 'en',
    params: {},
    bodyRendered: null,
    dedupeKey: `c1|stage_hr_interview|${id}`,
    status: 'queued',
    holdReason: null,
    attempts: 0,
    claimState: null,
    createdAt: '2026-11-14T09:00:00Z',
    sentAt: null,
    ...over,
  };
}

function rig() {
  const ctx: MemoryContext = {
    closed: false,
    inbox: 'recruiter',
    personal: false,
    optedOut: false,
    consent: true,
    lastInboundAt: '2026-11-14T09:30:00Z',
    contactName: ' Sara\n{x} ',
    settings: { ...DEFAULT_SETTINGS, killSwitch: false },
    triggerEnabled: true,
    template: {
      kind: 'hr_interview_invite',
      language: 'en',
      body: SEED_TEMPLATES.hr_interview_invite.text.en,
      metaTemplateName: 'hr_hr_interview_invite',
      approvalStatus: 'approved',
      category: 'utility',
    },
  };
  const clock = { now: () => new Date(NOW) };
  const store = new MemoryAutoMsgStore(ctx, clock);
  const sent: TemplateSendRequest[] = [];
  const sender: SendPort & { fail: boolean } = {
    fail: false,
    async send(req) {
      if (this.fail) throw new Error('provider unavailable '.repeat(50));
      sent.push(req);
      return {
        providerMessageId: `wamid-${sent.length}`,
        messageId: `m-${sent.length}`,
      };
    },
  };
  const deps: EngineDeps = { store, sender, clock };
  return { ctx, store, sender, sent, deps };
}

describe('processRow', () => {
  it('sends the approved template with sanitised params and marks it sent', async () => {
    const { store, sent, deps } = rig();
    store.add(row('r1'));
    expect(await processRow(row('r1'), deps)).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      metaTemplateName: 'hr_hr_interview_invite',
      params: { name: 'Sara x', slot: SLOT_FALLBACK },
    });
    expect(sent[0].body).toBe(
      `Hello Sara x, we would like to invite you to an HR interview on ${SLOT_FALLBACK}.`
    );
    expect(sent[0].templateBody).toBe(
      SEED_TEMPLATES.hr_interview_invite.text.en
    );
    expect(store.rows.get('r1')).toMatchObject({
      status: 'sent',
      attempts: 1,
      claimState: null,
      bodyRendered: sent[0].body,
    });
  });

  it('an empty name falls back to "there"', async () => {
    const { ctx, store, sent, deps } = rig();
    ctx.contactName = ' {} ';
    store.add(row('r1'));
    await processRow(row('r1'), deps);
    expect(sent[0].params.name).toBe('there');
  });

  it('a lost claim sends nothing', async () => {
    const { store, sent, deps } = rig();
    store.add(row('r1'));
    vi.spyOn(store, 'claim').mockResolvedValueOnce('lost');
    expect(await processRow(row('r1'), deps)).toBe('lost');
    expect(sent).toHaveLength(0);
  });

  it('capped: the claim recounts the cap and holds the row', async () => {
    const { ctx, store, sent, deps } = rig();
    ctx.settings = { ...ctx.settings, dailyCap: 1 };
    store.add(row('r0', { status: 'sent', sentAt: '2026-11-14T08:00:00Z' }));
    store.add(row('r1'));
    vi.spyOn(store, 'state').mockImplementationOnce(async (id) => ({
      ...(await MemoryAutoMsgStore.prototype.state.call(store, id))!,
      sentToday: 0,
    }));
    expect(await processRow(row('r1'), deps)).toBe('capped');
    expect(store.rows.get('r1')).toMatchObject({
      status: 'held',
      holdReason: 'daily_cap',
    });
    expect(sent).toHaveLength(0);
  });

  it('send throws -> failed with the error cut to 500', async () => {
    const { store, sender, deps } = rig();
    sender.fail = true;
    store.add(row('r1'));
    expect(await processRow(row('r1'), deps)).toBe('failed');
    expect(store.rows.get('r1')).toMatchObject({
      status: 'failed',
      attempts: 1,
      claimState: null,
    });
    expect(store.errors.get('r1')).toHaveLength(500);
  });

  it('a non-retryable send failure -> failed_terminal through failTerminal', async () => {
    const { store, sender, deps } = rig();
    store.add(row('r1'));
    const terminal = vi.spyOn(store, 'failTerminal');
    const failed = vi.spyOn(store, 'markFailed');
    sender.send = async () => {
      throw new MetaError('(#131026) undeliverable', 400, 131026);
    };
    expect(await processRow(row('r1'), deps)).toBe('failed_terminal');
    expect(terminal).toHaveBeenCalledWith('r1', 'undeliverable');
    expect(failed).not.toHaveBeenCalled();
    expect(store.rows.get('r1')).toMatchObject({
      status: 'failed',
      attempts: 3,
      claimState: null,
    });
    expect(store.errors.get('r1')).toBe('undeliverable');
    // Never retried: the next pass decides nothing.
    expect(await processRow(row('r1'), deps)).toBe('lost');
  });

  it('a local refusal is terminal with its own reason', async () => {
    const { store, sender, deps } = rig();
    store.add(row('r1'));
    sender.send = async () => {
      throw new HrSendRefusal('invalid_number', 'contact phone invalid');
    };
    expect(await processRow(row('r1'), deps)).toBe('failed_terminal');
    expect(store.errors.get('r1')).toBe('invalid_number');
  });

  it('a retryable send failure still goes through markFailed', async () => {
    const { store, sender, deps } = rig();
    store.add(row('r1'));
    const terminal = vi.spyOn(store, 'failTerminal');
    sender.send = async () => {
      throw new MetaError('server', 503);
    };
    expect(await processRow(row('r1'), deps)).toBe('failed');
    expect(terminal).not.toHaveBeenCalled();
    expect(store.rows.get('r1')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
  });

  it('markSent throws -> unconfirmed, and the next processDue sends nothing', async () => {
    const { store, sent, deps } = rig();
    store.add(row('r1'));
    vi.spyOn(store, 'markSent').mockRejectedValueOnce(new Error('db down'));
    expect(await processRow(row('r1'), deps)).toBe('unconfirmed');
    expect(store.rows.get('r1')).toMatchObject({
      status: 'sent',
      claimState: 'unconfirmed',
    });
    expect(await processDue([row('r1')], deps)).toEqual({ lost: 1 });
    expect(sent).toHaveLength(1);
  });

  it('accepted with no chat record (messageId null) -> unconfirmed, not sent', async () => {
    const { store, sender, sent, deps } = rig();
    store.add(row('r1'));
    sender.send = async (req) => {
      sent.push(req);
      return { providerMessageId: 'wamid-x', messageId: null };
    };
    expect(await processRow(row('r1'), deps)).toBe('unconfirmed');
    expect(store.rows.get('r1')).toMatchObject({ claimState: 'unconfirmed' });
  });

  it('closed or opted out -> cancelled', async () => {
    for (const k of ['closed', 'optedOut'] as const) {
      const { ctx, store, sent, deps } = rig();
      ctx[k] = true;
      store.add(row('r1'));
      expect(await processRow(row('r1'), deps)).toBe('cancelled');
      expect(store.rows.get('r1')!.status).toBe('cancelled');
      expect(sent).toHaveLength(0);
    }
  });

  it('a personal-number chat -> cancelled, even with every guard passing', async () => {
    const { ctx, store, sent, deps } = rig();
    ctx.personal = true;
    store.add(row('r1'));
    expect(await processRow(row('r1'), deps)).toBe('cancelled');
    expect(sent).toHaveLength(0);
  });

  it('older than 24 h -> cancelled, never sent late', async () => {
    const { store, sent, deps } = rig();
    const old = row('r1', { createdAt: '2026-11-13T09:59:00Z' });
    store.add(old);
    expect(await processRow(old, deps)).toBe('cancelled');
    expect(sent).toHaveLength(0);
  });

  it('a draft template is held inside the window; an unchanged hold is not rewritten', async () => {
    const { ctx, store, sent, deps } = rig();
    ctx.template = { ...ctx.template!, approvalStatus: 'draft' };
    store.add(row('r1'));
    expect(await processRow(row('r1'), deps)).toBe(
      'held:outside_window_no_template'
    );
    const hold = vi.spyOn(store, 'hold');
    expect(await processRow(row('r1'), deps)).toBe(
      'held:outside_window_no_template'
    );
    expect(hold).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('processDue', () => {
  it('ALREADY_DECIDED from hold counts as lost and the loop continues; other throws are error', async () => {
    const { ctx, store, deps } = rig();
    ctx.settings = { ...ctx.settings, killSwitch: true };
    for (const id of ['r1', 'r2', 'r3']) store.add(row(id));
    const hold = vi.spyOn(store, 'hold');
    hold.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { hint: 'ALREADY_DECIDED' })
    );
    hold.mockRejectedValueOnce(new Error('boom'));
    expect(await processDue([row('r1'), row('r2'), row('r3')], deps)).toEqual({
      lost: 1,
      error: 1,
      'held:kill_switch': 1,
    });
  });
});

describe('no free-text path', () => {
  const req: TemplateSendRequest = {
    accountId: 'a',
    conversationId: 'c',
    contactId: 'p',
    templateKind: 'cv_ack',
    language: 'en',
    metaTemplateName: 'hr_cv_ack',
    body: 'Hello Sara',
    templateBody: 'Hello {name}',
    params: { name: 'Sara', slot: 's' },
  };
  it('type level: a send request has no text field', () => {
    // @ts-expect-error there is no text field
    const a: TemplateSendRequest = { ...req, text: 'hello' };
    expect(a).toBeTruthy();
  });
  it('runtime: extra fields, extra params and a blank template name are refused', () => {
    expect(() => assertTemplateOnly(req)).not.toThrow();
    expect(() =>
      assertTemplateOnly({
        ...req,
        text: 'x',
      } as unknown as TemplateSendRequest)
    ).toThrow(/not allowed/);
    expect(() =>
      assertTemplateOnly({
        ...req,
        params: { ...req.params, extra: 'x' },
      } as unknown as TemplateSendRequest)
    ).toThrow(/not allowed/);
    expect(() => assertTemplateOnly({ ...req, metaTemplateName: '' })).toThrow(
      /template name/
    );
  });
});
