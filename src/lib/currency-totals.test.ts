import { describe, expect, it } from 'vitest';

import { formatCurrency, formatCurrencyShort } from './currency';
import {
  currencyAverages,
  currencyTotals,
  currencyTotalsCell,
  formatCurrencyTotals,
} from './currency-totals';

const aed = (value: number | string) => ({ value, currency: 'AED' });
const usd = (value: number | string) => ({ value, currency: 'USD' });

describe('currencyTotals', () => {
  it('never adds two currencies', () => {
    expect(
      currencyTotals([usd(100_000), aed('150000'), aed(50_000)], 'AED')
    ).toEqual([
      { currency: 'AED', value: 200_000 },
      { currency: 'USD', value: 100_000 },
    ]);
  });

  it('reads a deal without a currency in the account’s', () => {
    expect(
      currencyTotals(
        [
          { value: 1, currency: null },
          { value: 2 },
          { value: 3, currency: ' aed ' },
        ],
        'AED'
      )
    ).toEqual([{ currency: 'AED', value: 6 }]);
  });

  it('leaves out a currency that amounts to nothing, and is never empty', () => {
    expect(currencyTotals([aed(5), usd(0)], 'AED')).toEqual([
      { currency: 'AED', value: 5 },
    ]);
    expect(currencyTotals([usd(0)], 'AED')).toEqual([
      { currency: 'AED', value: 0 },
    ]);
    expect(currencyTotals([], 'AED')).toEqual([{ currency: 'AED', value: 0 }]);
  });
});

describe('currencyAverages', () => {
  it('averages each currency over its own deals', () => {
    expect(currencyAverages([aed(100), aed(0), usd(30)], 'AED')).toEqual([
      { currency: 'AED', value: 50 },
      { currency: 'USD', value: 30 },
    ]);
  });
});

describe('formatting', () => {
  const both = currencyTotals([aed(200_000), usd(100_000)], 'AED');

  it('shows one currency as before', () => {
    const one = [{ currency: 'AED', value: 1234 }];
    expect(formatCurrencyTotals(one)).toBe(formatCurrency(1234, 'AED'));
    expect(formatCurrencyTotals(one, 'short')).toBe(
      formatCurrencyShort(1234, 'AED')
    );
    expect(currencyTotalsCell(one)).toBe(1234);
  });

  it('names each of several by its code', () => {
    expect(formatCurrencyTotals(both)).toBe('AED 200,000 + USD 100,000');
    expect(formatCurrencyTotals(both, 'short')).toBe('AED 200.0k + USD 100.0k');
    expect(currencyTotalsCell(both)).toBe('AED 200,000 + USD 100,000');
  });
});
