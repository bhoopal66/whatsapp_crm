import { describe, expect, it } from 'vitest';

import {
  MAX_CHANNEL_LABEL_LEN,
  channelDisplayName,
  channelNameWithPhone,
  normalizeChannelLabel,
  usableNumbers,
  validateIdList,
  validateMemberIds,
} from './channel-management';

describe('normalizeChannelLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeChannelLabel('  Sales   team ')).toEqual({
      ok: true,
      label: 'Sales team',
    });
  });
  it('rejects empty, non-string, and over-long names', () => {
    expect(normalizeChannelLabel('   ').ok).toBe(false);
    expect(normalizeChannelLabel(42).ok).toBe(false);
    expect(
      normalizeChannelLabel('x'.repeat(MAX_CHANNEL_LABEL_LEN + 1)).ok
    ).toBe(false);
    expect(normalizeChannelLabel('x'.repeat(MAX_CHANNEL_LABEL_LEN)).ok).toBe(
      true
    );
  });
});

describe('validateMemberIds', () => {
  const members = new Set(['u1', 'u2']);
  it('accepts account members and de-duplicates', () => {
    expect(validateMemberIds(['u1', 'u2', 'u1'], members)).toEqual({
      ok: true,
      ids: ['u1', 'u2'],
    });
  });
  it('accepts an empty list — the number becomes shared again', () => {
    expect(validateMemberIds([], members)).toEqual({ ok: true, ids: [] });
  });
  it('rejects someone from another account', () => {
    const r = validateMemberIds(['u1', 'intruder'], members);
    expect(r.ok).toBe(false);
  });
  it('rejects a malformed body', () => {
    expect(validateMemberIds('u1', members).ok).toBe(false);
    expect(validateMemberIds([1], members).ok).toBe(false);
  });
});

describe('channelDisplayName', () => {
  it('prefers the label, then the number, then the gateway id', () => {
    expect(
      channelDisplayName({
        label: 'Sales',
        waba_id: '+91',
        phone_number_id: 'CH',
      })
    ).toBe('Sales');
    expect(
      channelDisplayName({ label: null, waba_id: '+91', phone_number_id: 'CH' })
    ).toBe('+91');
    expect(
      channelDisplayName({ label: null, waba_id: null, phone_number_id: 'CH' })
    ).toBe('CH');
  });
});

describe('usableNumbers (mirrors can_use_channel, migration 061)', () => {
  const sales = { id: 'sales' };
  const support = { id: 'support' };
  const meta = { id: 'meta' };
  const all = [sales, support, meta];
  // sales → alice; support → bob; meta → nobody (shared)
  const allocations = [
    { config_id: 'sales', user_id: 'alice' },
    { config_id: 'support', user_id: 'bob' },
  ];

  it('gives an agent their own numbers plus the shared ones', () => {
    expect(usableNumbers(all, allocations, 'alice', false)).toEqual([
      sales,
      meta,
    ]);
  });
  it('gives an agent on no number only the shared ones', () => {
    expect(usableNumbers(all, allocations, 'carol', false)).toEqual([meta]);
  });
  it('gives an admin every number', () => {
    expect(usableNumbers(all, allocations, 'carol', true)).toEqual(all);
  });
  it('gives nobody anything before the user is known', () => {
    expect(usableNumbers(all, allocations, null, false)).toEqual([]);
  });
});

describe('channelNameWithPhone', () => {
  const whapi = {
    provider: 'whapi',
    label: 'whapi 1',
    waba_id: '971558233531',
    phone_number_id: 'NIGHTW-JJC9J',
  };

  it('adds the paired phone to a Whapi number', () => {
    expect(channelNameWithPhone(whapi)).toBe('whapi 1 · +971558233531');
  });

  it('does not repeat a name that already is the number', () => {
    expect(
      channelNameWithPhone({ ...whapi, label: 'WhatsApp 971558233531' })
    ).toBe('WhatsApp 971558233531');
    expect(channelNameWithPhone({ ...whapi, label: null })).toBe(
      '971558233531'
    );
  });

  it('shows just the name when no phone is known', () => {
    expect(channelNameWithPhone({ ...whapi, waba_id: null })).toBe('whapi 1');
  });

  it('never shows a Meta WABA id as a phone', () => {
    expect(
      channelNameWithPhone({
        provider: 'meta',
        label: 'Marketing 1',
        waba_id: '491532200719769',
        phone_number_id: '713442518525749',
      })
    ).toBe('Marketing 1');
  });
});

describe('validateIdList', () => {
  it('accepts a list of strings and drops repeats', () => {
    expect(validateIdList(['t1', 't2', 't1'], 'team_ids')).toEqual({
      ok: true,
      ids: ['t1', 't2'],
    });
    expect(validateIdList([], 'team_ids')).toEqual({ ok: true, ids: [] });
  });
  it('rejects anything that is not a list of strings, naming the field', () => {
    expect(validateIdList('t1', 'team_ids')).toEqual({
      ok: false,
      error: 'team_ids must be an array of ids',
    });
    expect(validateIdList(['t1', 2], 'channel_ids').ok).toBe(false);
    expect(validateIdList(null, 'channel_ids').ok).toBe(false);
  });
});
