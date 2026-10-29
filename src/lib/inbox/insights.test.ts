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
import {
  PIN_LIMIT,
  ROW_CHIP_LIMIT,
  applyHandled,
  comparePinned,
  hasAttentionPin,
  pinnedSummary,
  shouldFetchUnloadedPin,
  isPinned,
  rowSignals,
  sortWithPins,
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
    ).toEqual({ ready: false, attentionPins: false, bounds: [] });
  });
  it('signals off: ready at once, no pins, no bounds', () => {
    expect(
      insightListQuery({
        signalsEnabled: false,
        settingsLoading: false,
        insightFilters: ['hot', 'upset'],
      })
    ).toEqual({ ready: true, attentionPins: false, bounds: [] });
  });
  it('signals on: pins and the filters bounds', () => {
    const q = insightListQuery({
      signalsEnabled: true,
      settingsLoading: false,
      insightFilters: ['upset'],
    });
    expect(q.ready).toBe(true);
    expect(q.attentionPins).toBe(true);
    expect(q.bounds).toEqual([INSIGHT_FILTER_BOUNDS.upset]);
  });
});

// ---------------------------------------------------------------------------
// Coloured rows and pinned until handled (migration 153)
// ---------------------------------------------------------------------------

const calm = {
  ...none,
  insight_sentiment: null,
  insight_attention_at: null,
  insight_attention_reason: null,
  ai_attention_at: null,
};

describe('rowSignals', () => {
  it('colours nothing for an unjudged or calm chat', () => {
    expect(rowSignals(calm)).toEqual({
      stripe: null,
      chips: [],
      attention: null,
    });
    expect(
      rowSignals({
        ...calm,
        insight_lead_temp: 0.2,
        insight_sentiment: 2,
        insight_intent: 'smalltalk',
      })
    ).toEqual({ stripe: null, chips: [], attention: null });
  });

  it('stripes by attention reason, then urgent priority, then hot/ready lead', () => {
    const all = {
      ...calm,
      insight_attention_at: '2026-10-29T08:00:00Z',
      insight_attention_reason: 'callback',
      insight_priority: 2,
      insight_lead_temp: 3,
    };
    expect(rowSignals(all).stripe).toEqual({
      family: 'attention',
      key: 'callback',
    });
    expect(rowSignals(all).attention).toEqual({
      reason: 'callback',
      since: '2026-10-29T08:00:00Z',
    });
    const noPin = { ...all, insight_attention_at: null };
    expect(rowSignals(noPin).stripe).toEqual({
      family: 'urgency',
      key: 'urgent',
    });
    expect(rowSignals({ ...noPin, insight_priority: 1 }).stripe).toEqual({
      family: 'lead',
      key: 'ready',
    });
    expect(
      rowSignals({ ...noPin, insight_priority: 0, insight_lead_temp: 1.5 })
        .stripe
    ).toEqual({ family: 'lead', key: 'hot' });
    // A warm lead tints a chip, never the row.
    expect(
      rowSignals({ ...noPin, insight_priority: 0, insight_lead_temp: 1 }).stripe
    ).toBeNull();
  });

  it('uses ai_handoff when Important, unless the stored reason is more severe', () => {
    const imp = { ...calm, ai_attention_at: '2026-10-29T07:00:00Z' };
    const s = rowSignals(imp, { important: true });
    expect(s.stripe).toEqual({ family: 'attention', key: 'ai_handoff' });
    expect(s.attention).toEqual({
      reason: 'ai_handoff',
      since: '2026-10-29T07:00:00Z',
    });
    // Not Important unless the caller says so.
    expect(rowSignals(imp).attention).toBeNull();
    const upset = {
      ...imp,
      insight_attention_at: '2026-10-29T06:00:00Z',
      insight_attention_reason: 'upset',
    };
    expect(rowSignals(upset, { important: true }).attention?.reason).toBe(
      'ai_handoff'
    );
    const urgent = { ...upset, insight_attention_reason: 'urgent' };
    expect(rowSignals(urgent, { important: true }).attention).toEqual({
      reason: 'urgent',
      since: '2026-10-29T06:00:00Z',
    });
  });

  it('ignores an attention reason it does not know (and ai_handoff stored there)', () => {
    for (const reason of ['mystery', null, 'ai_handoff']) {
      const s = rowSignals({
        ...calm,
        insight_attention_at: '2026-10-29T08:00:00Z',
        insight_attention_reason: reason,
      });
      expect(s.attention).toBeNull();
      expect(s.stripe).toBeNull();
    }
  });

  it('puts the attention reason or the mood first, then lead, then intent', () => {
    const row = {
      ...calm,
      insight_wants_human: 0.9,
      insight_upset: 0.9,
      insight_sentiment: 0.2,
      insight_lead_temp: 1,
      insight_intent: 'business_loan',
    };
    expect(rowSignals(row).chips).toEqual([
      { family: 'attention', key: 'wants_person' },
      { family: 'lead', key: 'warm' },
      { family: 'intent', key: 'business_loan' },
    ]);
    expect(rowSignals({ ...row, insight_wants_human: 0.1 }).chips[0]).toEqual({
      family: 'attention',
      key: 'upset',
    });
    expect(
      rowSignals({ ...row, insight_wants_human: 0.1, insight_upset: 0.1 })
        .chips[0]
    ).toEqual({ family: 'sentiment', key: 'very_negative' });
    // A merely negative mood is no chip.
    expect(
      rowSignals({
        ...row,
        insight_wants_human: 0.1,
        insight_upset: 0.1,
        insight_sentiment: 1,
      }).chips[0]
    ).toEqual({ family: 'lead', key: 'warm' });
    // An attention reason replaces the mood chip.
    expect(
      rowSignals({
        ...row,
        insight_attention_at: '2026-10-29T08:00:00Z',
        insight_attention_reason: 'callback',
      }).chips
    ).toEqual([
      { family: 'attention', key: 'callback' },
      { family: 'lead', key: 'warm' },
      { family: 'intent', key: 'business_loan' },
    ]);
  });

  it('never shows more than three chips, nor cold leads or vague intents', () => {
    expect(ROW_CHIP_LIMIT).toBe(3);
    const base = { ...calm, insight_lead_temp: 0.1 };
    for (const intent of ['smalltalk', 'unclear', 'nonsense'])
      expect(rowSignals({ ...base, insight_intent: intent }).chips).toEqual([]);
    expect(
      rowSignals({ ...base, insight_intent: 'other_request' }).chips
    ).toEqual([{ family: 'intent', key: 'other_request' }]);
  });
});

type PinRow = Parameters<typeof comparePinned>[0];

function pin(
  id: string,
  over: Partial<PinRow> & { last_message_at?: string } = {}
): PinRow {
  return {
    id,
    last_message_at: '2026-10-29T09:00:00Z',
    ai_attention_at: null,
    insight_attention_at: null,
    insight_attention_reason: null,
    ...over,
  };
}

const at = (reason: string, time: string) => ({
  insight_attention_at: time,
  insight_attention_reason: reason,
});

describe('isPinned', () => {
  it('is an attention stamp or an AI hand-off', () => {
    expect(isPinned(pin('a'))).toBe(false);
    expect(isPinned(pin('a', at('callback', '2026-10-29T08:00:00Z')))).toBe(
      true
    );
    expect(
      isPinned(pin('a', { ai_attention_at: '2026-10-29T08:00:00Z' }))
    ).toBe(true);
    // A stamp with an unknown reason still pins.
    expect(isPinned(pin('a', at('mystery', '2026-10-29T08:00:00Z')))).toBe(
      true
    );
    expect(isPinned(pin('a', { insight_attention_at: 'not a time' }))).toBe(
      false
    );
  });
});

describe('comparePinned / sortWithPins', () => {
  const ids = (rows: PinRow[]) => sortWithPins(rows).map((r) => r.id);

  it('orders by severity: urgent > ai_handoff > wants_person > upset > callback', () => {
    const rows = [
      pin('callback', at('callback', '2026-10-29T01:00:00Z')),
      pin('upset', at('upset', '2026-10-29T02:00:00Z')),
      pin('wants', at('wants_person', '2026-10-29T03:00:00Z')),
      pin('handoff', { ai_attention_at: '2026-10-29T04:00:00Z' }),
      pin('urgent', at('urgent', '2026-10-29T05:00:00Z')),
    ];
    expect(ids(rows)).toEqual([
      'urgent',
      'handoff',
      'wants',
      'upset',
      'callback',
    ]);
  });

  it('puts the longest waiting first within a reason, then newest message, then id DESC', () => {
    const rows = [
      pin('late', at('upset', '2026-10-29T08:00:00Z')),
      pin('early', at('upset', '2026-10-29T06:00:00Z')),
      pin('tieOld', {
        ...at('upset', '2026-10-29T07:00:00Z'),
        last_message_at: '2026-10-29T07:30:00Z',
      }),
      pin('tieNew', {
        ...at('upset', '2026-10-29T07:00:00Z'),
        last_message_at: '2026-10-29T07:45:00Z',
      }),
      pin('b', at('callback', '2026-10-29T05:00:00Z')),
      pin('c', at('callback', '2026-10-29T05:00:00Z')),
    ];
    expect(ids(rows)).toEqual(['early', 'tieNew', 'tieOld', 'late', 'c', 'b']);
  });

  it('ranks a row with both pins by its more severe one, timed by that one', () => {
    const both = pin('both', {
      ai_attention_at: '2026-10-29T09:00:00Z',
      ...at('callback', '2026-10-29T01:00:00Z'),
    });
    const handoff = pin('handoff', { ai_attention_at: '2026-10-29T08:00:00Z' });
    const wants = pin('wants', at('wants_person', '2026-10-29T00:00:00Z'));
    // both counts as ai_handoff since 09:00, after the 08:00 hand-off.
    expect(ids([wants, both, handoff])).toEqual(['handoff', 'both', 'wants']);
    const bothUrgent = pin('bothUrgent', {
      ai_attention_at: '2026-10-29T01:00:00Z',
      ...at('urgent', '2026-10-29T09:00:00Z'),
    });
    expect(ids([handoff, bothUrgent])).toEqual(['bothUrgent', 'handoff']);
  });

  it('puts an unknown reason after every known one, still above the rest', () => {
    const rows = [
      pin('plain', { last_message_at: '2026-10-29T10:00:00Z' }),
      pin('mystery', at('mystery', '2026-10-29T00:00:00Z')),
      pin('callback', at('callback', '2026-10-29T08:00:00Z')),
    ];
    expect(ids(rows)).toEqual(['callback', 'mystery', 'plain']);
  });

  it('keeps unpinned rows below, newest message first, and returns a copy', () => {
    const rows = [
      pin('old', { last_message_at: '2026-10-28T09:00:00Z' }),
      pin('new', { last_message_at: '2026-10-29T10:00:00Z' }),
      pin('pinned', {
        ...at('callback', '2026-10-29T08:00:00Z'),
        last_message_at: '2026-10-27T09:00:00Z',
      }),
    ];
    const sorted = sortWithPins(rows);
    expect(sorted.map((r) => r.id)).toEqual(['pinned', 'new', 'old']);
    expect(rows.map((r) => r.id)).toEqual(['old', 'new', 'pinned']);
    expect(comparePinned(rows[0], rows[1])).toBe(0);
    expect(comparePinned(rows[2], rows[0])).toBeLessThan(0);
    expect(comparePinned(rows[0], rows[2])).toBeGreaterThan(0);
  });
});

describe('Handled and the Pinned chip', () => {
  const pin = (
    id: string,
    at: string | null,
    reason: string | null = 'upset',
    ai: string | null = null
  ) => ({
    id,
    insight_attention_at: at,
    insight_attention_reason: reason,
    ai_attention_at: ai,
  });

  it('bounds the pin read at 50', () => {
    expect(PIN_LIMIT).toBe(50);
  });

  it('only a signal stamp is Handled-able', () => {
    expect(hasAttentionPin(pin('a', '2026-10-29T08:00:00Z'))).toBe(true);
    expect(hasAttentionPin(pin('a', null))).toBe(false);
    expect(hasAttentionPin(pin('a', 'not a date'))).toBe(false);
  });

  it('applyHandled clears only the handled stamp, keeping the row', () => {
    const rows = [
      pin('a', '2026-10-29T08:00:00Z'),
      pin('b', '2026-10-29T09:00:00Z', 'urgent'),
    ];
    const out = applyHandled(rows, new Map([['a', '2026-10-29T08:00:00Z']]));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'a',
      insight_attention_at: null,
      insight_attention_reason: null,
    });
    expect(isPinned(out[0])).toBe(false);
    expect(out[1]).toBe(rows[1]);
  });

  it('a newer signal since Handled pins again; no entry restores it', () => {
    const rows = [pin('a', '2026-10-29T10:00:00Z')];
    expect(applyHandled(rows, new Map([['a', '2026-10-29T08:00:00Z']]))).toBe(
      rows
    );
    expect(applyHandled(rows, new Map())).toBe(rows);
  });

  it('pinnedSummary counts every pin and flags urgent', () => {
    expect(
      pinnedSummary([
        pin('a', '2026-10-29T08:00:00Z'),
        pin('b', null, null, '2026-10-29T08:00:00Z'),
        pin('c', null),
      ])
    ).toEqual({ count: 2, urgent: false });
    expect(pinnedSummary([pin('a', '2026-10-29T08:00:00Z', 'urgent')])).toEqual(
      { count: 1, urgent: true }
    );
    expect(pinnedSummary([])).toEqual({ count: 0, urgent: false });
  });

  it('fetches an unloaded chat only when a signal pinned it, signals on', () => {
    const pinned = { insight_attention_at: '2026-10-29T08:00:00Z' };
    expect(shouldFetchUnloadedPin(pinned, true)).toBe(true);
    expect(shouldFetchUnloadedPin(pinned, false)).toBe(false);
    expect(shouldFetchUnloadedPin({ insight_attention_at: null }, true)).toBe(
      false
    );
  });
});
