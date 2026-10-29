import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  NEXT_ACTION_CODES,
  NEXT_ACTION_REASONS,
  nextBestActions,
  type NextActionFigures,
} from './next-action';
import { INSIGHT_PALETTE } from './palette';

const JUDGED = '2026-10-29T08:00:00Z';
const row = (f: NextActionFigures = {}): NextActionFigures => ({
  insight_at: JUDGED,
  ...f,
});
const codes = (f: NextActionFigures) =>
  nextBestActions(row(f)).map((a) => a.code);

describe('nextBestActions', () => {
  it('suggests nothing for a chat never judged, whatever the figures', () => {
    for (const f of [null, undefined, {}, { insight_at: null }]) {
      expect(nextBestActions(f as NextActionFigures)).toEqual([]);
    }
    expect(nextBestActions({ insight_at: null, insight_callback: 1 })).toEqual(
      []
    );
  });

  it('suggests nothing for a calm, judged chat', () => {
    expect(nextBestActions(row({ insight_lead_temp: 0 }))).toEqual([]);
  });

  it('call_back from the callback threshold, inclusive', () => {
    expect(codes({ insight_callback: CALLBACK_MIN_P })).toEqual(['call_back']);
    expect(codes({ insight_callback: CALLBACK_MIN_P - 0.01 })).toEqual([]);
    expect(nextBestActions(row({ insight_callback: 0.9 }))[0]).toEqual({
      code: 'call_back',
      because: ['asked_for_call'],
      tone: { family: 'attention', key: 'callback' },
    });
  });

  it('take_over from wanting a person or a wants_person pin', () => {
    expect(
      nextBestActions(row({ insight_wants_human: WANTS_PERSON_MIN }))[0]
    ).toMatchObject({ code: 'take_over', because: ['asked_for_person'] });
    expect(
      nextBestActions(row({ insight_attention_reason: 'wants_person' }))[0]
    ).toMatchObject({ code: 'take_over', because: ['pinned_for_person'] });
    expect(
      nextBestActions(
        row({
          insight_wants_human: 0.95,
          insight_attention_reason: 'wants_person',
        })
      )[0].because
    ).toEqual(['asked_for_person', 'pinned_for_person']);
    expect(codes({ insight_attention_reason: 'upset' })).toEqual([]);
    expect(codes({ insight_wants_human: WANTS_PERSON_MIN - 0.01 })).toEqual([]);
  });

  it('calm_down from upset or a very negative mood', () => {
    expect(nextBestActions(row({ insight_upset: UPSET_MIN }))[0]).toEqual({
      code: 'calm_down',
      because: ['upset'],
      tone: { family: 'attention', key: 'upset' },
    });
    expect(
      nextBestActions(
        row({ insight_sentiment: SENTIMENT_NEGATIVE_MIN - 0.1 })
      )[0]
    ).toEqual({
      code: 'calm_down',
      because: ['very_negative'],
      tone: { family: 'sentiment', key: 'very_negative' },
    });
    expect(
      nextBestActions(row({ insight_upset: 0.9, insight_sentiment: 0 }))[0]
        .because
    ).toEqual(['upset', 'very_negative']);
    // Merely negative is not enough.
    expect(codes({ insight_sentiment: SENTIMENT_NEGATIVE_MIN })).toEqual([]);
  });

  it('reply_now needs both an expected answer and unread messages', () => {
    const waiting = { insight_needs_reply: NEEDS_REPLY_MIN_P, unread_count: 1 };
    expect(nextBestActions(row(waiting))[0]).toMatchObject({
      code: 'reply_now',
      because: ['needs_reply', 'waiting'],
    });
    expect(codes({ ...waiting, unread_count: 0 })).toEqual([]);
    expect(codes({ ...waiting, unread_count: null })).toEqual([]);
    expect(codes({ ...waiting, insight_needs_reply: 0.5 })).toEqual([]);
  });

  it('send_documents from a ready lead or the documents objection', () => {
    expect(
      nextBestActions(row({ insight_lead_temp: LEAD_READY_MIN }))[0]
    ).toEqual({
      code: 'send_documents',
      because: ['ready_to_apply'],
      tone: { family: 'lead', key: 'ready' },
    });
    expect(
      nextBestActions(row({ insight_objections: ['documents'] }))[0]
    ).toEqual({
      code: 'send_documents',
      because: ['objection_documents'],
      tone: { family: 'objection', key: 'documents' },
    });
    expect(
      nextBestActions(
        row({ insight_lead_temp: 3, insight_objections: ['documents'] })
      )
    ).toHaveLength(1);
  });

  it('maps each other objection to its action, toned by the objection', () => {
    const pairs = [
      ['price', 'address_price'],
      ['eligibility', 'reassure_eligibility'],
      ['trust', 'build_trust'],
      ['timing', 'schedule_follow_up'],
      ['comparing', 'compare_offers'],
    ] as const;
    for (const [objection, code] of pairs) {
      expect(nextBestActions(row({ insight_objections: [objection] }))).toEqual(
        [
          {
            code,
            because: [`objection_${objection}`],
            tone: { family: 'objection', key: objection },
          },
        ]
      );
    }
    expect(codes({ insight_objections: ['nonsense'] })).toEqual([]);
  });

  it('move_forward only for a hot lead with no objection', () => {
    expect(nextBestActions(row({ insight_lead_temp: LEAD_HOT_MIN }))).toEqual([
      {
        code: 'move_forward',
        because: ['hot_lead'],
        tone: { family: 'lead', key: 'hot' },
      },
    ]);
    expect(
      codes({ insight_lead_temp: LEAD_HOT_MIN, insight_objections: ['price'] })
    ).toEqual(['address_price']);
    expect(codes({ insight_lead_temp: LEAD_HOT_MIN - 0.01 })).toEqual([]);
    // Ready gets send_documents instead.
    expect(codes({ insight_lead_temp: LEAD_READY_MIN })).toEqual([
      'send_documents',
    ]);
  });

  it('keeps at most two, in the fixed order', () => {
    const everything = row({
      insight_callback: 0.9,
      insight_wants_human: 0.9,
      insight_upset: 0.9,
      insight_needs_reply: 0.9,
      unread_count: 2,
      insight_objections: ['price', 'trust'],
    });
    expect(nextBestActions(everything).map((a) => a.code)).toEqual([
      'call_back',
      'take_over',
    ]);
    expect(
      codes({
        insight_objections: ['comparing', 'price'],
        insight_upset: 0.8,
      })
    ).toEqual(['calm_down', 'address_price']);
    expect(
      codes({ insight_objections: ['timing', 'comparing', 'eligibility'] })
    ).toEqual(['reassure_eligibility', 'schedule_follow_up']);
  });

  it('treats NaN and missing figures as absent', () => {
    expect(
      codes({
        insight_callback: NaN,
        insight_wants_human: NaN,
        insight_upset: NaN,
        insight_sentiment: NaN,
        insight_lead_temp: NaN,
        insight_objections: null,
      })
    ).toEqual([]);
  });

  it('every tone is a palette swatch', () => {
    const all = row({
      insight_callback: 1,
      insight_wants_human: 1,
      insight_upset: 1,
      insight_sentiment: 0,
      insight_needs_reply: 1,
      unread_count: 1,
      insight_lead_temp: 3,
      insight_objections: [
        'price',
        'documents',
        'eligibility',
        'trust',
        'timing',
        'comparing',
      ],
    });
    // Look past the cap by asking for each action alone as well.
    const tones = [
      ...nextBestActions(all),
      ...nextBestActions(row({ insight_lead_temp: 1.5 })),
    ].map((a) => a.tone);
    for (const t of tones) {
      const fam = INSIGHT_PALETTE[t.family] as Record<string, unknown>;
      expect(fam[t.key]).toBeDefined();
    }
  });
});

describe('InsightsUi.actions / trends messages', () => {
  const load = (locale: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')
    ).InsightsUi;

  it('labels every action, hint, reason and trend in en', () => {
    const ui = load('en');
    expect(Object.keys(ui.actions.codes)).toEqual([...NEXT_ACTION_CODES]);
    expect(Object.keys(ui.actions.hints)).toEqual([...NEXT_ACTION_CODES]);
    expect(Object.keys(ui.actions.reasons)).toEqual([...NEXT_ACTION_REASONS]);
    expect(ui.actions.hints.call_back).toBe('They asked for a call');
    expect(ui.actions.hints.calm_down).toBe('Acknowledge the problem first');
    expect(ui.actions.hints.move_forward).toBe('Suggest the next step: apply');
    expect(Object.keys(ui.trends.mood)).toEqual(
      expect.arrayContaining(['improving', 'steady', 'worsening'])
    );
    expect(Object.keys(ui.trends.lead)).toEqual(
      expect.arrayContaining(['warming', 'steady', 'cooling'])
    );
  });
});
