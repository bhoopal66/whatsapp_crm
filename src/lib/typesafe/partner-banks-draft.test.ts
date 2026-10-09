import { describe, expect, it } from 'vitest';
import {
  addCustomBank,
  effectiveCodes,
  removeCustomBank,
  samePartnerBanks,
  setCode,
  untickedMentions,
} from './partner-banks-draft';

const catalogue = [
  { code: 'MASHREQ', name: 'Mashreq', defaultPartner: true },
  { code: 'WIO', name: 'Wio Bank', defaultPartner: true },
  { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)', defaultPartner: false },
];

describe('partner banks draft', () => {
  it('ticks the built-in partners while the setting is null', () => {
    expect(effectiveCodes(null, catalogue)).toEqual(['MASHREQ', 'WIO']);
  });

  it('starts an explicit list from the built-in one on the first edit', () => {
    expect(setCode(null, catalogue, 'FAB', true)).toEqual({
      codes: ['MASHREQ', 'WIO', 'FAB'],
      custom: [],
    });
    expect(setCode(null, catalogue, 'WIO', false).codes).toEqual(['MASHREQ']);
  });

  it('adds a custom bank with its comma-separated names', () => {
    const r = addCustomBank(null, catalogue, ' Some Bank ', 'SB, , sb, Some');
    expect(r).toEqual({
      ok: true,
      value: {
        codes: ['MASHREQ', 'WIO'],
        custom: [{ name: 'Some Bank', aliases: ['SB', 'Some'] }],
      },
    });
    if (!r.ok) return;
    expect(addCustomBank(r.value, catalogue, 'some bank', '')).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(addCustomBank(r.value, catalogue, '  ', '')).toEqual({
      ok: false,
      reason: 'blank',
    });
    expect(removeCustomBank(r.value, catalogue, 'Some Bank').custom).toEqual(
      []
    );
  });

  it('compares codes as a set and null only with null', () => {
    expect(
      samePartnerBanks(
        { codes: ['A', 'B'], custom: [] },
        { codes: ['B', 'A'], custom: [] }
      )
    ).toBe(true);
    expect(samePartnerBanks(null, { codes: [], custom: [] })).toBe(false);
    expect(samePartnerBanks(null, null)).toBe(true);
  });

  it('suggests only knowledge-base banks that are not ticked', () => {
    const mentions = [
      { code: 'FAB', name: 'FAB', documents: 3 },
      { code: 'MASHREQ', name: 'Mashreq', documents: 1 },
    ];
    expect(untickedMentions(mentions, null, catalogue)).toEqual([mentions[0]]);
    expect(
      untickedMentions(
        mentions,
        setCode(null, catalogue, 'FAB', true),
        catalogue
      )
    ).toEqual([]);
  });
});
