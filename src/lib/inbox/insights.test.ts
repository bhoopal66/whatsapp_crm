import { describe, expect, it } from 'vitest';

import { LEAD_HOT_MIN, LEAD_READY_MIN, UPSET_MIN } from '@/lib/insights/bands';
import { sortForInbox } from './attention';
import {
  INSIGHT_FILTER_BOUNDS,
  insightBadge,
  insightListQuery,
  insightFilterBounds,
  insightSummary,
  isUrgentPin,
  matchesInsightFilters,
  parseInsightFilters,
  sortForInboxWithInsights,
} from './insights';

const none = {
  insight_intent: null,
  insight_urgency: null,
  insight_lead_temp: null,
  insight_upset: null,
  insight_wants_human: null,
  insight_priority: 0,
  insight_at: null,
};

describe('insightBadge', () => {
  it('shows nothing for an unjudged chat', () => {
    expect(insightBadge(none)).toBeNull();
  });
  it('follows Urgent > Upset > Wants a person > Ready > Hot', () => {
    const all = {
      ...none,
      insight_priority: 2,
      insight_upset: 0.9,
      insight_wants_human: 0.95,
      insight_lead_temp: 3,
    };
    expect(insightBadge(all)).toBe('urgent');
    expect(insightBadge({ ...all, insight_priority: 1 })).toBe('upset');
    expect(
      insightBadge({ ...all, insight_priority: 1, insight_upset: 0.2 })
    ).toBe('wants_person');
    const lead = { ...none, insight_priority: 1 };
    expect(insightBadge({ ...lead, insight_lead_temp: LEAD_READY_MIN })).toBe(
      'ready'
    );
    expect(insightBadge({ ...lead, insight_lead_temp: LEAD_HOT_MIN })).toBe(
      'hot'
    );
    expect(insightBadge({ ...lead, insight_lead_temp: 1 })).toBeNull();
  });
});

describe('insightSummary', () => {
  it('names what is known and drops an unknown intent key', () => {
    expect(
      insightSummary({
        ...none,
        insight_intent: 'business_loan',
        insight_urgency: 1,
        insight_lead_temp: 2,
        insight_upset: 0.1,
        insight_at: '2026-10-29T08:00:00Z',
      })
    ).toEqual({
      lead: 'hot',
      intent: 'business_loan',
      urgency: 'soon',
      upset: false,
      wantsPerson: false,
      at: '2026-10-29T08:00:00Z',
    });
    const s = insightSummary({ ...none, insight_intent: 'made_up' });
    expect(s.intent).toBeNull();
    expect(s.upset).toBeNull();
    expect(s.lead).toBeNull();
  });
});

describe('insight filters', () => {
  it('uses the bands thresholds', () => {
    expect(INSIGHT_FILTER_BOUNDS.hot.min).toBe(LEAD_HOT_MIN);
    expect(INSIGHT_FILTER_BOUNDS.upset.min).toBe(UPSET_MIN);
    expect(INSIGHT_FILTER_BOUNDS.attention).toEqual({
      column: 'insight_priority',
      min: 1,
    });
    expect(insightFilterBounds(['attention', 'hot'])).toEqual([
      INSIGHT_FILTER_BOUNDS.hot,
      INSIGHT_FILTER_BOUNDS.attention,
    ]);
  });
  it('narrows on every picked filter; a missing figure never passes', () => {
    expect(matchesInsightFilters(none, [])).toBe(true);
    expect(matchesInsightFilters(none, ['hot'])).toBe(false);
    const row = { ...none, insight_lead_temp: 1.4, insight_priority: 1 };
    expect(matchesInsightFilters(row, ['hot', 'attention'])).toBe(true);
    expect(matchesInsightFilters(row, ['hot', 'upset'])).toBe(false);
    expect(
      matchesInsightFilters({ ...row, insight_lead_temp: 1.39 }, ['hot'])
    ).toBe(false);
    expect(
      matchesInsightFilters({ ...none, insight_upset: 0.7 }, ['upset'])
    ).toBe(true);
  });
  it('parses ?insight=', () => {
    expect(parseInsightFilters(null)).toEqual([]);
    expect(parseInsightFilters('upset,HOT,nope,hot')).toEqual(['hot', 'upset']);
  });
});

describe('Urgent pin', () => {
  const row = (
    id: string,
    at: string,
    extra: Partial<{
      ai_attention_at: string | null;
      insight_priority: number;
      unread_count: number;
    }> = {}
  ) => ({
    id,
    last_message_at: at,
    ai_attention_at: null,
    insight_priority: 0,
    unread_count: 0,
    ...extra,
  });

  it('needs priority 2 and an unread message', () => {
    expect(isUrgentPin({ insight_priority: 2, unread_count: 1 })).toBe(true);
    expect(isUrgentPin({ insight_priority: 2, unread_count: 0 })).toBe(false);
    expect(isUrgentPin({ insight_priority: 1, unread_count: 3 })).toBe(false);
  });

  it('pins urgent unread chats under the Important ones', () => {
    const rows = [
      row('new', '2026-10-29T10:00:00Z'),
      row('urgOld', '2026-10-20T10:00:00Z', {
        insight_priority: 2,
        unread_count: 1,
      }),
      row('urgNew', '2026-10-28T10:00:00Z', {
        insight_priority: 2,
        unread_count: 2,
      }),
      row('urgRead', '2026-10-27T10:00:00Z', { insight_priority: 2 }),
      row('imp', '2026-10-01T10:00:00Z', {
        ai_attention_at: '2026-10-01T11:00:00Z',
      }),
      row('impUrg', '2026-10-02T10:00:00Z', {
        ai_attention_at: '2026-10-01T09:00:00Z',
        insight_priority: 2,
        unread_count: 1,
      }),
    ];
    expect(sortForInboxWithInsights(rows, true).map((r) => r.id)).toEqual([
      'imp',
      'impUrg',
      'urgNew',
      'urgOld',
      'new',
      'urgRead',
    ]);
  });

  it('keeps the old order exactly when signals are off', () => {
    const rows = [
      row('a', '2026-10-20T10:00:00Z', {
        insight_priority: 2,
        unread_count: 1,
      }),
      row('b', '2026-10-29T10:00:00Z'),
    ];
    expect(sortForInboxWithInsights(rows, false)).toEqual(sortForInbox(rows));
  });
});

describe('insightBadge on an Important row', () => {
  it('never says Urgent twice: the next badge, or none', () => {
    const urgent = {
      insight_intent: null,
      insight_urgency: 2,
      insight_lead_temp: null,
      insight_upset: 0.9,
      insight_wants_human: null,
      insight_priority: 2,
      insight_at: null,
    };
    expect(insightBadge(urgent)).toBe('urgent');
    expect(insightBadge(urgent, { important: true })).toBe('upset');
    expect(
      insightBadge({ ...urgent, insight_upset: 0 }, { important: true })
    ).toBeNull();
  });
});

describe('insightListQuery', () => {
  it('waits for the settings, whatever else is asked', () => {
    expect(
      insightListQuery({
        signalsEnabled: false,
        settingsLoading: true,
        insightFilters: ['hot'],
      })
    ).toEqual({ ready: false, urgentPins: false, bounds: [] });
  });
  it('signals off: ready at once, no pins, no bounds', () => {
    expect(
      insightListQuery({
        signalsEnabled: false,
        settingsLoading: false,
        insightFilters: ['hot', 'upset'],
      })
    ).toEqual({ ready: true, urgentPins: false, bounds: [] });
  });
  it('signals on: pins and the filters bounds', () => {
    const q = insightListQuery({
      signalsEnabled: true,
      settingsLoading: false,
      insightFilters: ['upset'],
    });
    expect(q.ready).toBe(true);
    expect(q.urgentPins).toBe(true);
    expect(q.bounds).toEqual([INSIGHT_FILTER_BOUNDS.upset]);
  });
});
