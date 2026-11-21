import { describe, expect, it } from 'vitest';

import { caseRefOf, docKeyOf, parseCaptionText } from './caption';

describe('parseCaptionText', () => {
  it('reads a pending document by caption code or case number', () => {
    expect(parseCaptionText('  4271rakd   ejari ')).toEqual({
      kind: 'pending_doc',
      caseRef: '4271RAKD',
      docWord: 'ejari',
    });
    expect(parseCaptionText('TC-26-04271-RAK2')).toEqual({
      kind: 'pending_doc',
      caseRef: 'TC-26-04271-RAK2',
    });
  });

  it('reads INFO and NEW', () => {
    expect(parseCaptionText('INFO 1RAK1 customer travelling')).toEqual({
      kind: 'info',
      caseRef: '1RAK1',
      note: 'customer travelling',
    });
    expect(parseCaptionText('new rak Kite General Trading 12-34567')).toEqual({
      kind: 'new_case',
      deskCode: 'RAK',
      company: 'Kite General Trading',
      licence: '12-34567',
    });
  });

  it('never guesses', () => {
    expect(parseCaptionText('licence copy')).toEqual({
      kind: null,
      note: 'licence copy',
    });
    expect(parseCaptionText('NEW RAKB Kite 1234').kind).toBeNull();
    expect(parseCaptionText('NEW RAK Kite')).toEqual({
      kind: null,
      note: 'NEW RAK Kite',
    });
    expect(parseCaptionText('INFO nothing')).toEqual({
      kind: null,
      note: 'INFO nothing',
    });
    expect(parseCaptionText('   ')).toEqual({ kind: null, note: '' });
    expect(caseRefOf('0123RAKD')).toBeNull();
  });

  it('turns a doc word into a doc key or nothing', () => {
    expect(docKeyOf('trade licence')).toBe('trade_licence');
    expect(docKeyOf('bank-statement')).toBe('bank_statement');
    expect(docKeyOf('ejari!')).toBeNull();
    expect(docKeyOf(undefined)).toBeNull();
  });
});
