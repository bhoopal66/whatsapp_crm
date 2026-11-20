import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLAIM_STATE_KEYS,
  HISTORY_FILTERS,
  HOLD_REASON_KEYS,
  cancelErrorKey,
  historyRowView,
  historyStatusArg,
} from './history-view';
import { ALL_HOLD_REASONS, OUTBOX_STATUSES, type OutboxStatus } from './types';

const row = (
  status: OutboxStatus,
  claimState: 'sending' | 'unconfirmed' | 'needs_review' | null = null
) => ({
  status,
  holdReason: status === 'held' ? ('quiet_hours' as const) : null,
  claimState,
  conversationId: 'c-1',
});

describe('historyRowView', () => {
  it('offers Cancel on queued, held and failed rows without a claim', () => {
    for (const status of OUTBOX_STATUSES) {
      const want = ['queued', 'held', 'failed'].includes(status);
      expect(historyRowView(row(status), 'admin').canCancel).toBe(want);
      expect(historyRowView(row(status), 'lead').canCancel).toBe(want);
    }
  });

  it('never offers Cancel on a claimed row or to anyone else', () => {
    for (const claim of ['sending', 'unconfirmed', 'needs_review'] as const)
      expect(historyRowView(row('failed', claim), 'admin').canCancel).toBe(
        false
      );
    expect(historyRowView(row('queued'), null).canCancel).toBe(false);
  });

  it('maps hold and claim to label keys and links the chat', () => {
    const v = historyRowView(row('held', 'unconfirmed'), 'admin');
    expect(v).toMatchObject({
      statusKey: 'held',
      holdKey: 'quietHours',
      claimKey: 'unconfirmed',
      href: '/hr/recruiter?c=c-1',
    });
    expect(historyRowView(row('sent'), 'admin').holdKey).toBeNull();
  });
});

describe('filters and errors', () => {
  it('maps All to no status filter', () => {
    expect(HISTORY_FILTERS[0]).toBe('all');
    expect(historyStatusArg('all')).toBeNull();
    expect(historyStatusArg('held')).toBe('held');
  });

  it('words ALREADY_DECIDED apart from other refusals', () => {
    expect(cancelErrorKey('ALREADY_DECIDED')).toBe('history.alreadyDecided');
    expect(cancelErrorKey('NOT_ALLOWED')).toBe('error.NOT_ALLOWED');
    expect(cancelErrorKey('NOT_FOUND')).toBe('error.UNKNOWN');
  });
});

describe('labels', () => {
  const automsg = (file: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'messages', file), 'utf8')).Hr
      .automsg;

  it.each(['en.json', 'ko.json'])(
    '%s labels every status, hold reason, claim state and filter',
    (file) => {
      const h = automsg(file).history;
      for (const s of OUTBOX_STATUSES) expect(h.status[s]).toBeTruthy();
      for (const r of ALL_HOLD_REASONS)
        expect(h.hold[HOLD_REASON_KEYS[r]]).toBeTruthy();
      for (const c of Object.values(CLAIM_STATE_KEYS))
        expect(h.claim[c]).toBeTruthy();
      for (const f of HISTORY_FILTERS) expect(h.filter[f]).toBeTruthy();
      expect(h.alreadyDecided).toBeTruthy();
    }
  );
});

describe('channel', () => {
  it('names each row channel, a missing one as WhatsApp', () => {
    const v = (channel?: 'whatsapp' | 'rcs' | null) =>
      historyRowView({ ...row('sent'), channel }, 'admin').channelKey;
    expect(v('rcs')).toBe('channel.rcs');
    expect(v('whatsapp')).toBe('channel.whatsapp');
    expect(v(null)).toBe('channel.whatsapp');
    expect(historyRowView(row('sent'), 'admin').channelKey).toBe(
      'channel.whatsapp'
    );
  });

  it.each(['en.json', 'ko.json'])('%s labels the Channel column', (file) => {
    const a = JSON.parse(
      readFileSync(join(process.cwd(), 'messages', file), 'utf8')
    ).Hr.automsg;
    expect(a.history.channel).toBeTruthy();
    expect(a.channel.whatsapp && a.channel.rcs).toBeTruthy();
  });
});
