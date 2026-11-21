import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AutoMsgConsentView } from './api';
import {
  CONSENT_SOURCES,
  consentPanel,
  consentRows,
  consentSourceKey,
  sharedNotice,
} from './consent-view';

const base: AutoMsgConsentView = {
  granted: null,
  source: null,
  notedAt: null,
  optedOut: false,
  personal: false,
};

describe('consentPanel', () => {
  it('a personal chat shows the personal note and no buttons', () => {
    expect(
      consentPanel({ ...base, personal: true, granted: true }, true)
    ).toEqual({
      state: { kind: 'personal' },
      canRecord: false,
      canWithdraw: false,
    });
  });

  it('an opted-out candidate shows opted out and no buttons', () => {
    expect(consentPanel({ ...base, optedOut: true }, true)).toEqual({
      state: { kind: 'optedOut' },
      canRecord: false,
      canWithdraw: false,
    });
  });

  it('given consent offers withdraw', () => {
    const p = consentPanel(
      {
        ...base,
        granted: true,
        source: 'form',
        notedAt: '2026-11-16T09:00:00Z',
      },
      true
    );
    expect(p.state).toEqual({
      kind: 'given',
      source: 'form',
      notedAt: '2026-11-16T09:00:00Z',
    });
    expect(p.canRecord).toBe(false);
    expect(p.canWithdraw).toBe(true);
  });

  it('withdrawn consent offers record', () => {
    const p = consentPanel({ ...base, granted: false, notedAt: 'x' }, true);
    expect(p.state).toEqual({ kind: 'withdrawn', notedAt: 'x' });
    expect(p.canRecord).toBe(true);
    expect(p.canWithdraw).toBe(false);
  });

  it('no record offers record', () => {
    const p = consentPanel(base, true);
    expect(p.state).toEqual({ kind: 'none' });
    expect(p.canRecord).toBe(true);
  });

  it('read-only people get no buttons', () => {
    for (const granted of [true, false, null]) {
      const p = consentPanel({ ...base, granted }, false);
      expect(p.canRecord || p.canWithdraw).toBe(false);
    }
  });

  it('every source has a label', () => {
    const en = JSON.parse(
      readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
    ) as { Hr: { consent: { source: Record<string, string> } } };
    for (const s of CONSENT_SOURCES) {
      expect(consentSourceKey(s)).toBe(`consent.source.${s}`);
      expect(en.Hr.consent.source[s]).toBeTruthy();
    }
  });
});

describe('consentRows', () => {
  const ok = (c: Partial<AutoMsgConsentView>) => ({
    status: 'ok' as const,
    consent: { ...base, ...c },
  });
  const kinds = (rows: ReturnType<typeof consentRows>) =>
    rows.map((r) => (r.status === 'ok' ? r.state.kind : r.status));

  it('gives one row per channel, WhatsApp first, each labelled', () => {
    const rows = consentRows(
      { whatsapp: ok({}), rcs: ok({}), sms: ok({}) },
      true
    );
    expect(rows.map((r) => [r.channel, r.labelKey])).toEqual([
      ['whatsapp', 'automsg.channel.whatsapp'],
      ['rcs', 'automsg.channel.rcs'],
      ['sms', 'automsg.channel.sms'],
    ]);
  });

  it('RCS granted while WhatsApp is not', () => {
    const rows = consentRows(
      {
        whatsapp: ok({ granted: false }),
        rcs: ok({ granted: true }),
        sms: ok({ granted: null }),
      },
      true
    );
    expect(kinds(rows)).toEqual(['withdrawn', 'given', 'none']);
    expect(rows.map((r) => r.status === 'ok' && r.canRecord)).toEqual([
      true,
      false,
      true,
    ]);
    expect(rows.map((r) => r.status === 'ok' && r.canWithdraw)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('WhatsApp granted while RCS has no record', () => {
    const rows = consentRows(
      {
        whatsapp: ok({ granted: true }),
        rcs: ok({ granted: null }),
        sms: ok({ granted: true }),
      },
      true
    );
    expect(kinds(rows)).toEqual(['given', 'none', 'given']);
    expect(rows.map((r) => r.status === 'ok' && r.canWithdraw)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('opted out holds every row, whichever read reports it', () => {
    const rows = consentRows(
      {
        whatsapp: ok({ granted: true }),
        rcs: ok({ optedOut: true }),
        sms: ok({ granted: true }),
      },
      true
    );
    expect(kinds(rows)).toEqual(['optedOut', 'optedOut', 'optedOut']);
    expect(rows.some((r) => r.status === 'ok' && r.canRecord)).toBe(false);
    expect(sharedNotice(rows)).toBe('optedOut');
  });

  it('a personal chat holds every row', () => {
    const rows = consentRows(
      {
        whatsapp: ok({ personal: true }),
        rcs: ok({ granted: true }),
        sms: ok({}),
      },
      true
    );
    expect(kinds(rows)).toEqual(['personal', 'personal', 'personal']);
    expect(rows.some((r) => r.status === 'ok' && r.canWithdraw)).toBe(false);
    expect(sharedNotice(rows)).toBe('personal');
  });

  it('a failed read fails only its own row', () => {
    const rows = consentRows(
      {
        whatsapp: ok({ granted: true }),
        rcs: { status: 'failed' },
        sms: ok({}),
      },
      true
    );
    expect(kinds(rows)).toEqual(['given', 'failed', 'none']);
    expect(sharedNotice(rows)).toBeNull();
    expect(kinds(consentRows({}, true))).toEqual([
      'loading',
      'loading',
      'loading',
    ]);
  });

  it('labels the per-channel strings in both catalogues', () => {
    for (const file of ['en.json', 'ko.json']) {
      const hr = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', file), 'utf8')
      ).Hr;
      expect(hr.consent.perChannel).toBeTruthy();
      expect(hr.consent.sourceLabelFor).toContain('{channel}');
      expect(hr.automsg.channel.whatsapp).toBeTruthy();
      expect(hr.automsg.channel.rcs).toBeTruthy();
      expect(hr.automsg.channel.sms).toBeTruthy();
    }
  });
});
