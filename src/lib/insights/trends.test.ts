import { describe, expect, it } from 'vitest';

import {
  LEAD_CHANGE_MIN,
  MOOD_CHANGE_MIN,
  TREND_SERIES_MAX,
  insightTrends,
  type InsightEvent,
} from './trends';

/** Events one minute apart, oldest first, from per-message figures. */
const events = (figs: Record<string, unknown>[]): InsightEvent[] =>
  figs.map((figures, i) => ({
    at: new Date(Date.UTC(2026, 9, 29, 8, i)).toISOString(),
    figures,
  }));
const moods = (xs: (number | null)[]) =>
  events(xs.map((sentiment) => ({ sentiment })));
const leads = (xs: (number | null)[]) =>
  events(xs.map((leadTemp) => ({ leadTemp })));

describe('insightTrends', () => {
  it('has no trend and an empty series with no events', () => {
    for (const e of [null, undefined, []])
      expect(insightTrends(e)).toEqual({ mood: null, lead: null, series: [] });
  });

  it('needs at least four values on a scale', () => {
    expect(insightTrends(moods([1, 1, 4])).mood).toBeNull();
    expect(insightTrends(moods([1, 4, 4, 4])).mood).toBe('improving');
    // Missing values do not count towards the four.
    expect(insightTrends(moods([1, null, 4, null, 4])).mood).toBeNull();
  });

  it('compares the newest three with the three before them', () => {
    // Older mean 1, newer mean 3.
    expect(insightTrends(moods([0, 1, 1, 1, 3, 3, 3])).mood).toBe('improving');
    expect(insightTrends(moods([3, 3, 3, 1, 1, 1])).mood).toBe('worsening');
    expect(insightTrends(moods([2, 2, 2, 2, 2, 2])).mood).toBe('steady');
    // Anything older than six points is ignored.
    expect(insightTrends(moods([4, 4, 4, 2, 2, 2, 2, 2, 2])).mood).toBe(
      'steady'
    );
  });

  it('counts a change of exactly the named delta, not less', () => {
    const base = 2;
    expect(
      insightTrends(
        moods([base, base, base, ...Array(3).fill(base + MOOD_CHANGE_MIN)])
      ).mood
    ).toBe('improving');
    expect(
      insightTrends(
        moods([
          base,
          base,
          base,
          ...Array(3).fill(base + MOOD_CHANGE_MIN - 0.01),
        ])
      ).mood
    ).toBe('steady');
    expect(
      insightTrends(leads([1, 1, 1, ...Array(3).fill(1 - LEAD_CHANGE_MIN)]))
        .lead
    ).toBe('cooling');
    expect(
      insightTrends(
        leads([1, 1, 1, ...Array(3).fill(1 - LEAD_CHANGE_MIN + 0.01)])
      ).lead
    ).toBe('steady');
  });

  it('names the lead direction warming / cooling / steady', () => {
    expect(insightTrends(leads([0, 0, 0, 2, 2, 2])).lead).toBe('warming');
    expect(insightTrends(leads([2, 2, 2, 0, 0, 0])).lead).toBe('cooling');
    expect(insightTrends(leads([1, 1, 1, 1])).lead).toBe('steady');
  });

  it('judges each scale on its own values and skips non-numbers', () => {
    const e = events([
      { sentiment: 1, leadTemp: 'x' },
      { sentiment: 1 },
      { sentiment: 1, leadTemp: 2 },
      { sentiment: 3, leadTemp: NaN },
      { sentiment: 3 },
      { sentiment: 3 },
    ]);
    const t = insightTrends(e);
    expect(t.mood).toBe('improving');
    expect(t.lead).toBeNull();
    expect(t.series[0]).toEqual({ at: e[0].at, sentiment: 1, leadTemp: null });
    expect(t.series[2].leadTemp).toBe(2);
  });

  it('accepts events newest first (as the API answers) and orders the series', () => {
    const e = moods([3, 3, 3, 1, 1, 1]).reverse();
    const t = insightTrends(e);
    expect(t.mood).toBe('worsening');
    expect(t.series.map((p) => p.sentiment)).toEqual([3, 3, 3, 1, 1, 1]);
  });

  it('keeps the newest twelve points in the series, and drops unparseable dates', () => {
    const e = moods(Array.from({ length: 20 }, (_, i) => i % 5));
    const t = insightTrends([
      ...e,
      { at: 'garbage', figures: { sentiment: 0 } },
    ]);
    expect(t.series).toHaveLength(TREND_SERIES_MAX);
    expect(t.series[TREND_SERIES_MAX - 1].at).toBe(e[19].at);
    expect(t.series[0].at).toBe(e[8].at);
  });

  it('tolerates a null figures object', () => {
    const t = insightTrends([{ at: '2026-10-29T08:00:00Z', figures: null }]);
    expect(t.series).toEqual([
      { at: '2026-10-29T08:00:00Z', sentiment: null, leadTemp: null },
    ]);
  });
});
