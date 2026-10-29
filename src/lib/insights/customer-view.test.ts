import { describe, expect, it } from 'vitest';

import {
  CALLBACK_MIN_P,
  LEAD_HOT_MIN,
  LEAD_READY_MIN,
  NEEDS_REPLY_MIN_P,
  SENTIMENT_NEGATIVE_MIN,
  UPSET_MIN,
  WANTS_PERSON_MIN,
} from './bands';
import {
  CUSTOMER_INSIGHT_COLUMNS,
  LEAD_METER_STEPS,
  customerInsightView,
  insightTileHref,
  pinnedTileHref,
  leadMeter,
  countInsightTiles,
} from './customer-view';
import { parseInboxFilterParams } from '@/lib/inbox/filter-params';
import {
  INSIGHT_FILTER_BOUNDS,
  parseInsightFilters,
} from '@/lib/inbox/insights';

describe('customerInsightView', () => {
  it('is empty for a chat never judged', () => {
    for (const row of [null, undefined, {}, { insight_at: null }]) {
      const v = customerInsightView(row);
      expect(v.judged).toBe(false);
      expect(v.intent).toBeNull();
      expect(v.meter).toEqual([]);
      expect(v.mood).toBeNull();
      expect(v.basedOnAt).toBeNull();
      expect(v.sentiment).toBeNull();
      expect(v.objections).toEqual([]);
      expect(v.needsReply).toBe(false);
      expect(v.callback).toBe(false);
      expect(v.attention).toBeNull();
    }
  });

  it('reads the sentiment band, and a sentiment alone counts as judged', () => {
    const v = customerInsightView({ insight_sentiment: 0.4 });
    expect(v.sentiment).toBe('very_negative');
    expect(v.judged).toBe(true);
    expect(
      customerInsightView({ insight_sentiment: SENTIMENT_NEGATIVE_MIN })
        .sentiment
    ).toBe('negative');
    expect(
      customerInsightView({ insight_sentiment: NaN }).sentiment
    ).toBeNull();
  });

  it('keeps known objections once each, in display order', () => {
    const v = customerInsightView({
      insight_objections: ['trust', 'bogus', 'price', 'trust'],
    });
    expect(v.objections).toEqual(['price', 'trust']);
    expect(v.judged).toBe(true);
    expect(
      customerInsightView({ insight_objections: null }).objections
    ).toEqual([]);
  });

  it('flags needs reply and call back at their thresholds', () => {
    const at = customerInsightView({
      insight_needs_reply: NEEDS_REPLY_MIN_P,
      insight_callback: CALLBACK_MIN_P,
    });
    expect(at.needsReply).toBe(true);
    expect(at.callback).toBe(true);
    const below = customerInsightView({
      insight_needs_reply: NEEDS_REPLY_MIN_P - 0.01,
      insight_callback: CALLBACK_MIN_P - 0.01,
    });
    expect(below.needsReply).toBe(false);
    expect(below.callback).toBe(false);
  });

  it('reads the pin: reason and since; an unknown reason keeps the pin', () => {
    const v = customerInsightView({
      insight_attention_at: '2026-10-29T08:00:00Z',
      insight_attention_reason: 'wants_person',
    });
    expect(v.attention).toEqual({
      reason: 'wants_person',
      since: new Date('2026-10-29T08:00:00Z'),
    });
    expect(
      customerInsightView({
        insight_attention_at: '2026-10-29T08:00:00Z',
        insight_attention_reason: 'mystery',
      }).attention?.reason
    ).toBeNull();
    expect(
      customerInsightView({
        insight_attention_at: 'nope',
        insight_attention_reason: 'urgent',
      }).attention
    ).toBeNull();
  });

  it('reads every figure of a judged chat', () => {
    const v = customerInsightView({
      insight_intent: 'business_loan',
      insight_intent_p: 0.823,
      insight_lead_temp: LEAD_HOT_MIN,
      insight_urgency: 1.6,
      insight_upset: 0.1,
      insight_wants_human: 0.1,
      insight_at: '2026-10-29T08:00:00.000Z',
    });
    expect(v).toMatchObject({
      judged: true,
      intent: 'business_loan',
      intentPercent: 82,
      lead: 'hot',
      urgency: 'urgent',
      mood: ['calm'],
    });
    expect(v.basedOnAt?.toISOString()).toBe('2026-10-29T08:00:00.000Z');
  });

  it('drops an unknown intent key and its certainty', () => {
    const v = customerInsightView({
      insight_intent: 'crypto',
      insight_intent_p: 0.9,
    });
    expect(v.intent).toBeNull();
    expect(v.intentPercent).toBeNull();
    expect(v.judged).toBe(false);
  });

  it('shows no certainty outside 0..1', () => {
    expect(
      customerInsightView({ insight_intent: 'complaint', insight_intent_p: 3 })
        .intentPercent
    ).toBeNull();
  });

  it('lists upset and wants a person together, never calm with them', () => {
    expect(
      customerInsightView({
        insight_upset: UPSET_MIN,
        insight_wants_human: WANTS_PERSON_MIN,
      }).mood
    ).toEqual(['upset', 'wantsPerson']);
    expect(
      customerInsightView({ insight_wants_human: WANTS_PERSON_MIN }).mood
    ).toEqual(['wantsPerson']);
  });

  it('says nothing about mood when the upset figure is unknown', () => {
    expect(customerInsightView({ insight_wants_human: 0.1 }).mood).toBeNull();
  });

  it('ignores an invalid timestamp', () => {
    expect(
      customerInsightView({ insight_lead_temp: 0, insight_at: 'nope' })
        .basedOnAt
    ).toBeNull();
  });

  it('selects every column it reads', () => {
    const cols = CUSTOMER_INSIGHT_COLUMNS.split(',').map((s) => s.trim());
    expect(cols.sort()).toEqual(
      [
        'insight_at',
        'insight_intent',
        'insight_intent_p',
        'insight_lead_temp',
        'insight_upset',
        'insight_urgency',
        'insight_wants_human',
        'insight_sentiment',
        'insight_objections',
        'insight_needs_reply',
        'insight_callback',
        'insight_attention_at',
        'insight_attention_reason',
        'unread_count',
      ].sort()
    );
  });
});

describe('leadMeter', () => {
  it('highlights the current band and fills up to it', () => {
    expect(leadMeter('hot')).toEqual([
      { band: 'cold', current: false, reached: true },
      { band: 'warm', current: false, reached: true },
      { band: 'hot', current: true, reached: true },
      { band: 'ready', current: false, reached: false },
    ]);
  });

  it('has four steps, coldest first, and one current step per band', () => {
    expect(LEAD_METER_STEPS).toEqual(['cold', 'warm', 'hot', 'ready']);
    for (const band of LEAD_METER_STEPS) {
      expect(leadMeter(band).filter((s) => s.current)).toHaveLength(1);
    }
    expect(
      customerInsightView({ insight_lead_temp: LEAD_READY_MIN }).meter.at(-1)
        ?.current
    ).toBe(true);
  });

  it('is empty without a band', () => {
    expect(leadMeter(null)).toEqual([]);
  });
});

describe('home tiles', () => {
  const base = {
    campaign_broadcast_id: null,
    human_engaged_at: null,
    assigned_agent_id: undefined,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    chat_tag_id: null,
  };
  const campaign = {
    ...base,
    campaign_broadcast_id: 'b',
    ai_reply_count: 2,
  };

  it('count unread hot / upset chats on the inbox filters bounds', () => {
    const rows = [
      { ...base, unread_count: 1, insight_lead_temp: LEAD_HOT_MIN },
      { ...base, unread_count: 2, insight_upset: UPSET_MIN },
      { ...base, unread_count: 1, insight_lead_temp: 1, insight_upset: 0.1 },
      { ...base, unread_count: 0, insight_lead_temp: 3, insight_upset: 1 },
    ];
    expect(countInsightTiles(rows, false)).toEqual({
      hotWaiting: 1,
      upsetWaiting: 1,
    });
    expect(INSIGHT_FILTER_BOUNDS.hot.min).toBe(LEAD_HOT_MIN);
    expect(INSIGHT_FILTER_BOUNDS.upset.min).toBe(UPSET_MIN);
  });

  it('leave out the Campaign inbox only while the AI is live, like the unread tile', () => {
    const rows = [
      { ...campaign, unread_count: 1, insight_lead_temp: 3, insight_upset: 1 },
    ];
    expect(countInsightTiles(rows, true)).toEqual({
      hotWaiting: 0,
      upsetWaiting: 0,
    });
    expect(countInsightTiles(rows, false)).toEqual({
      hotWaiting: 1,
      upsetWaiting: 1,
    });
  });

  it('links the Pinned tile to the inbox Pinned chip', () => {
    expect(pinnedTileHref('/team-inbox')).toBe('/team-inbox?pinned=1');
    const q = new URL(pinnedTileHref('/inbox'), 'http://x').searchParams;
    expect(parseInboxFilterParams(q, null).pinned).toBe(true);
  });

  it('link into the inbox with filters the inbox parses', () => {
    expect(insightTileHref('/inbox', 'hot')).toBe(
      '/inbox?insight=hot&filter=unread'
    );
    expect(insightTileHref('/team-inbox', 'upset')).toBe(
      '/team-inbox?insight=upset&filter=unread'
    );
    for (const f of ['hot', 'upset'] as const) {
      const q = new URL(insightTileHref('/inbox', f), 'http://x').searchParams;
      expect(parseInsightFilters(q.get('insight'))).toEqual([f]);
      expect(parseInboxFilterParams(q, null).unread).toBe(true);
    }
  });
});
