import { describe, expect, it } from 'vitest';

import {
  CHECK_ALPHABET,
  captionCode,
  captionCodeOf,
  checkChar,
  formatCaseNumber,
  parseCaption,
  parseCaseNumber,
} from './case-number';

describe('case desk numbers', () => {
  it('matches the SQL vectors pinned in verify-case-desk.sql', () => {
    expect(captionCode(1, 'RAK')).toBe('1RAK1');
    expect(captionCode(4271, 'RAK')).toBe('4271RAKD');
    expect(captionCode(4271, 'RAK2')).toBe('4271RAK2K');
    expect(captionCode(1234567, 'ENB')).toBe('1234567ENBV');
    expect(checkChar('2600001RAK')).toBe('N');
    expect(formatCaseNumber(26, 4271, 'RAK')).toBe('TC-26-04271-RAK');
    expect(formatCaseNumber(26, 123456, 'RAK2')).toBe('TC-26-123456-RAK2');
  });

  it('formats and parses TC-YY-NNNNN-BBB(+digit)', () => {
    expect(parseCaseNumber('TC-26-04271-RAK2')).toEqual({
      yy: 26,
      seq: 4271,
      bank: 'RAK',
      slot: 2,
      bankPart: 'RAK2',
    });
    for (const bad of [
      'TC-26-00000-RAK',
      'TC-26-0001-RAK',
      'TC-26-00001-RA',
      'TC-26-00001-RAK1',
      'tc-26-00001-rak',
      'TC-26-012345-RAK',
      'TC-26-12345678-RAK',
    ])
      expect(parseCaseNumber(bad)).toBeNull();
    expect(() => formatCaseNumber(26, 0, 'RAK')).toThrow(RangeError);
    expect(() => formatCaseNumber(100, 1, 'RAK')).toThrow(RangeError);
    expect(() => formatCaseNumber(26, 10000000, 'RAK')).toThrow(RangeError);
    expect(() => formatCaseNumber(26, 1, 'RAK1')).toThrow(RangeError);
  });

  it('parses a caption code as typed and refuses a bad check', () => {
    const c = captionCode(4271, 'RAK2');
    expect(parseCaption(` ${c.toLowerCase().split('').join(' ')} `)).toEqual({
      seq: 4271,
      bankPart: 'RAK2',
      check: c.slice(-1),
    });
    expect(parseCaption('0' + c)).toBeNull();
    expect(parseCaption(c + 'X')).toBeNull();
    expect(captionCodeOf('TC-26-04271-RAK2')).toBe(c);
    expect(captionCodeOf('nope')).toBeNull();
  });

  it('catches every single substitution in the payload', () => {
    const p = '04271RAK2';
    const base = checkChar(p);
    for (let i = 0; i < p.length; i++) {
      for (const ch of CHECK_ALPHABET) {
        if (ch === p[i]) continue;
        expect(checkChar(p.slice(0, i) + ch + p.slice(i + 1))).not.toBe(base);
      }
    }
    expect(() => checkChar('ab')).toThrow(RangeError);
    expect(() => checkChar('')).toThrow(RangeError);
  });
});
