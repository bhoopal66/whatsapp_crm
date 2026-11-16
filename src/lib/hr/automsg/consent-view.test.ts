import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AutoMsgConsentView } from './api';
import {
  CONSENT_SOURCES,
  consentPanel,
  consentSourceKey,
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
