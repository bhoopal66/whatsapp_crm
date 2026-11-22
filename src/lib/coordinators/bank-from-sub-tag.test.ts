import { describe, expect, it } from 'vitest';

import { bankFromSubTag } from './bank-from-sub-tag';

const BANKS = [
  { code: 'ADCB', name: 'Abu Dhabi Commercial Bank' },
  { code: 'ENBD', name: 'Emirates NBD' },
  { code: 'RAK', name: 'RAKBANK' },
];

describe('bankFromSubTag', () => {
  it('matches a bank code, ignoring case and spaces', () => {
    expect(bankFromSubTag('ADCB', BANKS)).toBe('ADCB');
    expect(bankFromSubTag('  adcb ', BANKS)).toBe('ADCB');
  });

  it('matches a bank name, ignoring case and spaces', () => {
    expect(bankFromSubTag('emirates nbd', BANKS)).toBe('ENBD');
    expect(bankFromSubTag(' Rakbank ', BANKS)).toBe('RAK');
  });

  it('selects nothing without an exact match', () => {
    expect(bankFromSubTag('ADC', BANKS)).toBeNull();
    expect(bankFromSubTag('Emirates', BANKS)).toBeNull();
    expect(bankFromSubTag('Bank: ADCB', BANKS)).toBeNull();
  });

  it('selects nothing for an empty sub-tag or bank list', () => {
    expect(bankFromSubTag(null, BANKS)).toBeNull();
    expect(bankFromSubTag(undefined, BANKS)).toBeNull();
    expect(bankFromSubTag('   ', BANKS)).toBeNull();
    expect(bankFromSubTag('ADCB', [])).toBeNull();
  });

  it('prefers a code match over another bank named the same', () => {
    const banks = [
      { code: 'FAB', name: 'First Abu Dhabi Bank' },
      { code: 'XYZ', name: 'FAB' },
    ];
    expect(bankFromSubTag('fab', banks)).toBe('FAB');
  });

  it('selects nothing when the name is ambiguous', () => {
    const banks = [
      { code: 'A1', name: 'Same Bank' },
      { code: 'A2', name: 'same bank' },
    ];
    expect(bankFromSubTag('Same Bank', banks)).toBeNull();
  });
});
