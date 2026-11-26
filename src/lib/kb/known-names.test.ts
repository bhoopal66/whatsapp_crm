import { describe, expect, it } from 'vitest';

import { buildNameMatcher } from './known-names';

const mask = (text: string, ...names: string[]) =>
  buildNameMatcher(names).mask(text);

describe('buildNameMatcher', () => {
  it('masks whole words and phrases, any case', () => {
    expect(
      mask('Hi Ahmed Khan, AHMED here. Ahmedabad branch', 'Ahmed Khan')
    ).toBe('Hi [NAME], [NAME] here. Ahmedabad branch');
    expect(mask('José and jose', 'JOSE')).toBe('[NAME] and [NAME]');
    expect(mask('from Al-Noor Trading LLC', 'Al Noor Trading LLC')).toBe(
      'from [NAME]'
    );
  });
  it('takes Arabic prefixes off and folds letters', () => {
    expect(mask('لمحمد وأحمد وبالنور', 'محمد', 'احمد', 'النور')).toBe(
      '[NAME] [NAME] [NAME]'
    );
    expect(mask('مُحَمَّد و فاطمه', 'محمد', 'فاطمة')).toBe('[NAME] و [NAME]');
    expect(mask('عبدالله هنا إن شاء الله', 'عبد الله')).toBe(
      '[NAME] هنا إن شاء الله'
    );
    // A name that begins with a prefix letter is still a name.
    expect(mask('وسام', 'وسام')).toBe('[NAME]');
  });
  it('a two-letter Latin name only where it is capitalised', () => {
    expect(mask('Ask Bo, he said bo', 'Bo')).toBe('Ask [NAME], he said bo');
    expect(mask('Al is here', 'Al')).toBe('Al is here');
  });
  it('a name of common business words does not blank the evidence', () => {
    const text = 'A business loan in Dubai needs a trade licence.';
    expect(mask(text, 'Business Loan Dubai', 'Trade Licence')).toBe(text);
    expect(mask('We are Business Loan Dubai', 'Business Loan Dubai')).toBe(
      'We are [NAME]'
    );
  });
  it('leaves its own masks alone', () => {
    expect(mask('[NAME] [PHONE:567] phone', 'Name Phone Id')).toContain(
      '[NAME] [PHONE:567]'
    );
  });
  it('finds the 1,001st name', () => {
    const suffix = (i: number) =>
      String.fromCharCode(
        97 + (i % 26),
        97 + (Math.floor(i / 26) % 26),
        97 + (Math.floor(i / 676) % 26)
      );
    const names = Array.from({ length: 1001 }, (_, i) => `zq${suffix(i)}`);
    expect(mask(`ask ${names[1000]}`, ...names)).toBe('ask [NAME]');
  });
});
