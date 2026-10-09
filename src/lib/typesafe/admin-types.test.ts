import { describe, expect, it } from 'vitest';
import { PARTNER_BANKS_LIMITS, parsePartnerBanks } from './admin-types';

describe('parsePartnerBanks', () => {
  it('reads a valid value as is', () => {
    expect(
      parsePartnerBanks({
        codes: ['MASHREQ', 'FAB'],
        custom: [{ name: 'Some Bank', aliases: ['SB'] }],
      })
    ).toEqual({
      codes: ['MASHREQ', 'FAB'],
      custom: [{ name: 'Some Bank', aliases: ['SB'] }],
    });
  });

  it('treats a missing custom list as empty', () => {
    expect(parsePartnerBanks({ codes: [] })).toEqual({ codes: [], custom: [] });
    expect(parsePartnerBanks({ codes: ['fab'], custom: 'x' })).toEqual({
      codes: ['FAB'],
      custom: [],
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'MASHREQ'],
    ['an object without codes', {}],
    ['codes not an array', { codes: 'x' }],
  ])('returns null (the built-in list) for %s', (_label, raw) => {
    expect(parsePartnerBanks(raw)).toBeNull();
  });

  it('trims and uppercases codes, dropping bad and duplicate ones', () => {
    expect(
      parsePartnerBanks({
        codes: [' mashreq ', 'Fab', 3, null, '', '   ', 'MASHREQ', { x: 1 }],
      })?.codes
    ).toEqual(['MASHREQ', 'FAB']);
  });

  it('drops custom banks without a usable name and cleans aliases', () => {
    expect(
      parsePartnerBanks({
        codes: [],
        custom: [
          null,
          'Some Bank',
          [],
          { aliases: ['x'] },
          { name: '   ', aliases: ['x'] },
          { name: 42 },
          { name: '  Some Bank  ', aliases: [' SB ', '', 7, 'sb', 'S.B.'] },
          { name: 'some bank', aliases: ['dup'] },
          { name: 'Other Bank', aliases: 'OB' },
        ],
      })?.custom
    ).toEqual([
      { name: 'Some Bank', aliases: ['SB', 'S.B.'] },
      { name: 'Other Bank', aliases: [] },
    ]);
  });

  it('cuts text to 80 characters', () => {
    const long = `${'a'.repeat(79)} bcd`;
    const parsed = parsePartnerBanks({
      codes: [long],
      custom: [{ name: long, aliases: [long] }],
    });
    expect(PARTNER_BANKS_LIMITS.chars).toBe(80);
    // Cut at 80, then trimmed: the space at position 80 goes.
    expect(parsed?.codes).toEqual(['A'.repeat(79)]);
    expect(parsed?.custom[0].name).toBe('a'.repeat(79));
    expect(parsed?.custom[0].aliases).toEqual(['a'.repeat(79)]);
    const exact = 'b'.repeat(80);
    expect(
      parsePartnerBanks({ codes: [], custom: [{ name: `${exact}zzz` }] })
        ?.custom[0].name
    ).toBe(exact);
  });

  it('caps the lists at 50 custom banks, 50 codes and 10 aliases', () => {
    const parsed = parsePartnerBanks({
      codes: Array.from({ length: 60 }, (_, i) => `C${i}`),
      custom: [
        {
          name: 'Many aliases',
          aliases: Array.from({ length: 15 }, (_, i) => `a${i}`),
        },
        ...Array.from({ length: 60 }, (_, i) => ({ name: `Bank ${i}` })),
      ],
    });
    expect(parsed?.codes).toHaveLength(50);
    expect(parsed?.codes[49]).toBe('C49');
    expect(parsed?.custom).toHaveLength(50);
    expect(parsed?.custom[0].aliases).toHaveLength(10);
    expect(parsed?.custom[0].aliases[9]).toBe('a9');
    expect(parsed?.custom[49].name).toBe('Bank 48');
  });

  it('counts only kept entries towards the caps', () => {
    const parsed = parsePartnerBanks({
      codes: [...Array.from({ length: 60 }, () => ''), 'FAB'],
      custom: [
        ...Array.from({ length: 60 }, () => ({ name: '' })),
        {
          name: 'Kept',
          aliases: [...Array.from({ length: 20 }, () => ' '), 'K'],
        },
      ],
    });
    expect(parsed).toEqual({
      codes: ['FAB'],
      custom: [{ name: 'Kept', aliases: ['K'] }],
    });
  });

  it('gives a missing aliases list as empty', () => {
    expect(
      parsePartnerBanks({ codes: [], custom: [{ name: 'Solo' }] })?.custom
    ).toEqual([{ name: 'Solo', aliases: [] }]);
  });
});
