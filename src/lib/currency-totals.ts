import {
  DEFAULT_CURRENCY,
  formatCompactNumber,
  formatCurrency,
  formatCurrencyShort,
} from './currency';

// ------------------------------------------------------------
// Sums of deal values. A deal's currency is chosen per deal, so values
// are only ever added within one currency. Pure.
// ------------------------------------------------------------

/** Something with a value in a currency; none means the account's. */
export interface CurrencyAmount {
  value?: number | string | null;
  currency?: string | null;
}

export interface CurrencyTotal {
  currency: string;
  value: number;
}

/**
 * The currency a deal's value is in: its own, else the account's default
 * (as `deal-form.tsx` and `dashboard_open_deal_values` read it).
 */
export function dealCurrency(
  currency: string | null | undefined,
  fallback: string
): string {
  return currency?.trim().toUpperCase() || fallback || DEFAULT_CURRENCY;
}

function sums(
  items: readonly CurrencyAmount[],
  fallback: string
): Map<string, { value: number; count: number }> {
  const out = new Map<string, { value: number; count: number }>();
  for (const item of items) {
    const code = dealCurrency(item.currency, fallback);
    const sum = out.get(code) ?? { value: 0, count: 0 };
    sum.value += Number(item.value) || 0;
    sum.count += 1;
    out.set(code, sum);
  }
  return out;
}

/** The account's currency first, the others by code. */
function ordered(totals: CurrencyTotal[], fallback: string): CurrencyTotal[] {
  return totals.sort(
    (a, b) =>
      Number(b.currency === fallback) - Number(a.currency === fallback) ||
      a.currency.localeCompare(b.currency)
  );
}

/** Drops currencies that amount to nothing; never empty. */
function worthShowing(
  totals: CurrencyTotal[],
  fallback: string
): CurrencyTotal[] {
  const some = totals.filter((t) => t.value !== 0);
  return some.length > 0
    ? ordered(some, fallback)
    : [{ currency: fallback || DEFAULT_CURRENCY, value: 0 }];
}

/** One total per currency; a lone zero in the account's when there is none. */
export function currencyTotals(
  items: readonly CurrencyAmount[],
  fallback: string
): CurrencyTotal[] {
  return worthShowing(
    [...sums(items, fallback)].map(([currency, s]) => ({
      currency,
      value: s.value,
    })),
    fallback
  );
}

/** The average value per currency, over that currency's own deals. */
export function currencyAverages(
  items: readonly CurrencyAmount[],
  fallback: string
): CurrencyTotal[] {
  return worthShowing(
    [...sums(items, fallback)].map(([currency, s]) => ({
      currency,
      value: s.value / s.count,
    })),
    fallback
  );
}

function grouped(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    value
  );
}

/**
 * One total as it has always been shown; several by code, because symbols
 * are shared: "AED 200,000", "USD 100,000". Join or stack as fits.
 */
export function currencyTotalParts(
  totals: readonly CurrencyTotal[],
  format: 'full' | 'short' = 'full'
): string[] {
  const short = format === 'short';
  if (totals.length === 1) {
    const { value, currency } = totals[0];
    return [
      short
        ? formatCurrencyShort(value, currency)
        : formatCurrency(value, currency),
    ];
  }
  return totals.map(
    (t) =>
      `${t.currency} ${short ? formatCompactNumber(t.value) : grouped(t.value)}`
  );
}

/** "AED 200,000 + USD 100,000". */
export function formatCurrencyTotals(
  totals: readonly CurrencyTotal[],
  format: 'full' | 'short' = 'full'
): string {
  return currencyTotalParts(totals, format).join(' + ');
}

/** A spreadsheet cell: the plain number in one currency, else the text. */
export function currencyTotalsCell(
  totals: readonly CurrencyTotal[]
): number | string {
  if (totals.length === 1) return totals[0].value;
  return totals
    .map((t) => `${t.currency} ${grouped(t.value, 'en-US')}`)
    .join(' + ');
}
