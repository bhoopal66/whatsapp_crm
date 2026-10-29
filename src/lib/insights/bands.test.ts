import { describe, expect, it } from 'vitest';
import { INTENTS } from '@/lib/typesafe/questions/triage';
import { DEEP_QUESTIONS } from '@/lib/typesafe/questions/insights';
import {
  ATTENTION_CALLBACK_P,
  ATTENTION_REASONS,
  ATTENTION_UPSET_P,
  ATTENTION_WANTS_PERSON_P,
  CALLBACK_MIN_P,
  NEEDS_REPLY_MIN_P,
  OBJECTION_CODES,
  OBJECTION_MIN_P,
  attentionReason,
  objectionsFrom,
  sentimentBand,
  INSIGHT_INTENT_KEYS,
  TAG_SUGGEST_MIN_P,
  isUpset,
  leadBand,
  PRIORITY_HIGH,
  PRIORITY_NONE,
  PRIORITY_URGENT,
  priorityOf,
  urgencyBand,
  wantsPerson,
} from './bands';

describe('insight bands', () => {
  it('lists the triage intent keys, in order', () => {
    expect([...INSIGHT_INTENT_KEYS]).toEqual(Object.keys(INTENTS));
  });

  it('bands lead temperature at its edges', () => {
    expect(leadBand(0)).toBe('cold');
    expect(leadBand(0.599)).toBe('cold');
    expect(leadBand(0.6)).toBe('warm');
    expect(leadBand(1.399)).toBe('warm');
    expect(leadBand(1.4)).toBe('hot');
    expect(leadBand(2.249)).toBe('hot');
    expect(leadBand(2.25)).toBe('ready');
    expect(leadBand(3)).toBe('ready');
    expect(leadBand(null)).toBeNull();
    expect(leadBand(undefined)).toBeNull();
    expect(leadBand(Number.NaN)).toBeNull();
  });

  it('bands urgency at its edges', () => {
    expect(urgencyBand(0)).toBe('none');
    expect(urgencyBand(0.799)).toBe('none');
    expect(urgencyBand(0.8)).toBe('soon');
    expect(urgencyBand(1.499)).toBe('soon');
    expect(urgencyBand(1.5)).toBe('urgent');
    expect(urgencyBand(null)).toBeNull();
  });

  it('flags upset and wants-a-person at their edges', () => {
    expect(isUpset(0.699)).toBe(false);
    expect(isUpset(0.7)).toBe(true);
    expect(isUpset(null)).toBe(false);
    expect(wantsPerson(0.799)).toBe(false);
    expect(wantsPerson(0.8)).toBe(true);
    expect(wantsPerson(undefined)).toBe(false);
  });

  it('ranks priority at its edges, null figures counting as absent', () => {
    expect(priorityOf({})).toBe(0);
    expect(
      priorityOf({
        urgency: null,
        upset: null,
        wantsHuman: null,
        leadTemp: null,
      })
    ).toBe(0);
    expect(
      priorityOf({
        urgency: 0.79,
        upset: 0.69,
        wantsHuman: 0.79,
        leadTemp: 2.24,
      })
    ).toBe(0);

    expect(priorityOf({ urgency: 0.8 })).toBe(1);
    expect(priorityOf({ upset: 0.7 })).toBe(1);
    expect(priorityOf({ wantsHuman: 0.8 })).toBe(1);
    expect(priorityOf({ leadTemp: 2.25 })).toBe(1);
    expect(priorityOf({ urgency: 1.49, upset: 0.84, wantsHuman: 0.89 })).toBe(
      1
    );

    expect(priorityOf({ urgency: 1.5 })).toBe(2);
    expect(priorityOf({ upset: 0.85 })).toBe(2);
    expect(priorityOf({ wantsHuman: 0.9 })).toBe(2);
    // a ready lead alone is never top priority
    expect(priorityOf({ leadTemp: 3 })).toBe(1);
  });

  it('suggests a tag only from 0.55', () => {
    expect(TAG_SUGGEST_MIN_P).toBe(0.55);
  });
});

describe('priority levels', () => {
  it('are the values priorityOf returns', () => {
    expect([PRIORITY_NONE, PRIORITY_HIGH, PRIORITY_URGENT]).toEqual([0, 1, 2]);
    expect(priorityOf({})).toBe(PRIORITY_NONE);
    expect(priorityOf({ upset: 0.8 })).toBe(PRIORITY_HIGH);
    expect(priorityOf({ upset: 0.9 })).toBe(PRIORITY_URGENT);
  });
});

describe('customer insights bands (v2)', () => {
  it('lists the objection codes the deep questions ask, in order', () => {
    expect([...OBJECTION_CODES]).toEqual([
      'price',
      'documents',
      'eligibility',
      'trust',
      'timing',
      'comparing',
    ]);
    const asked = Object.keys(DEEP_QUESTIONS)
      .filter((k) => k.startsWith('objection_'))
      .map((k) => k.slice('objection_'.length));
    expect(asked).toEqual([...OBJECTION_CODES]);
  });

  it('keeps objections at or above OBJECTION_MIN_P, in code order', () => {
    expect(OBJECTION_MIN_P).toBe(0.6);
    expect(
      objectionsFrom({
        comparing: 0.9,
        price: 0.6,
        documents: 0.599,
        trust: 0.61,
        timing: null,
        eligibility: Number.NaN,
      })
    ).toEqual(['price', 'trust', 'comparing']);
    expect(objectionsFrom({})).toEqual([]);
    expect(objectionsFrom(null)).toEqual([]);
    expect(objectionsFrom(undefined)).toEqual([]);
  });

  it('names the reply and call-back thresholds', () => {
    expect(NEEDS_REPLY_MIN_P).toBe(0.6);
    expect(CALLBACK_MIN_P).toBe(0.7);
  });

  it('bands sentiment at its edges', () => {
    expect(sentimentBand(0)).toBe('very_negative');
    expect(sentimentBand(0.999)).toBe('very_negative');
    expect(sentimentBand(1)).toBe('negative');
    expect(sentimentBand(1.749)).toBe('negative');
    expect(sentimentBand(1.75)).toBe('neutral');
    expect(sentimentBand(2.499)).toBe('neutral');
    expect(sentimentBand(2.5)).toBe('positive');
    expect(sentimentBand(3.249)).toBe('positive');
    expect(sentimentBand(3.25)).toBe('very_positive');
    expect(sentimentBand(4)).toBe('very_positive');
    expect(sentimentBand(null)).toBeNull();
    expect(sentimentBand(undefined)).toBeNull();
    expect(sentimentBand(Number.NaN)).toBeNull();
  });
});

describe('attentionReason', () => {
  const ALL_ON = {
    urgent: true,
    upset: true,
    wantsPerson: true,
    callback: true,
  };
  /** Every condition holds. */
  const ALL = { urgency: 1.9, wantsHuman: 0.95, upset: 0.95, callback: 0.95 };

  it('lists the reasons in precedence order with their thresholds', () => {
    expect([...ATTENTION_REASONS]).toEqual([
      'urgent',
      'wants_person',
      'upset',
      'callback',
    ]);
    expect(ATTENTION_WANTS_PERSON_P).toBe(0.85);
    expect(ATTENTION_UPSET_P).toBe(0.85);
    expect(ATTENTION_CALLBACK_P).toBe(0.75);
  });

  it('returns the highest-precedence reason that holds', () => {
    expect(attentionReason(ALL, ALL_ON)).toBe('urgent');
    // Without time pressure the label names the actual cause, even where
    // priorityOf's blend would call the chat urgent.
    expect(attentionReason({ ...ALL, urgency: 0 }, ALL_ON)).toBe(
      'wants_person'
    );
    expect(attentionReason({ upset: 0.95 }, ALL_ON)).toBe('upset');
    const NO_URGENT = { ...ALL_ON, urgent: false };
    const notUrgent = { wantsHuman: 0.87, upset: 0.86, callback: 0.8 };
    expect(attentionReason(notUrgent, NO_URGENT)).toBe('wants_person');
    expect(attentionReason({ ...notUrgent, wantsHuman: 0 }, NO_URGENT)).toBe(
      'upset'
    );
    expect(
      attentionReason({ ...notUrgent, wantsHuman: 0, upset: 0 }, NO_URGENT)
    ).toBe('callback');
    expect(attentionReason({}, NO_URGENT)).toBeNull();
  });

  it('counts urgent as time pressure alone', () => {
    expect(attentionReason({ urgency: 1.5 }, ALL_ON)).toBe('urgent');
    expect(attentionReason({ urgency: 1.499 }, ALL_ON)).toBeNull();
    // priorityOf calls these urgent too; the pin names the real cause
    expect(attentionReason({ wantsHuman: 0.95 }, ALL_ON)).toBe('wants_person');
    expect(attentionReason({ upset: 0.9 }, ALL_ON)).toBe('upset');
    // ready to apply is only PRIORITY_HIGH: not an attention reason
    expect(attentionReason({ leadTemp: 3 }, ALL_ON)).toBeNull();
  });

  it('holds each threshold at its edge', () => {
    expect(attentionReason({ wantsHuman: 0.85 }, ALL_ON)).toBe('wants_person');
    expect(attentionReason({ wantsHuman: 0.849 }, ALL_ON)).toBeNull();
    expect(attentionReason({ upset: 0.85 }, ALL_ON)).toBe('upset');
    expect(attentionReason({ upset: 0.849 }, ALL_ON)).toBeNull();
    expect(attentionReason({ callback: 0.75 }, ALL_ON)).toBe('callback');
    expect(attentionReason({ callback: 0.749 }, ALL_ON)).toBeNull();
  });

  it('skips a reason whose rule is off', () => {
    expect(attentionReason(ALL, { ...ALL_ON, urgent: false })).toBe(
      'wants_person'
    );
    expect(
      attentionReason(ALL, { ...ALL_ON, urgent: false, wantsPerson: false })
    ).toBe('upset');
    expect(
      attentionReason(ALL, {
        urgent: false,
        wantsPerson: false,
        upset: false,
        callback: true,
      })
    ).toBe('callback');
    expect(attentionReason(ALL, { ...ALL_ON, callback: false })).toBe('urgent');
    expect(
      attentionReason(ALL, {
        urgent: false,
        wantsPerson: false,
        upset: false,
        callback: false,
      })
    ).toBeNull();
  });

  it('treats null and NaN figures as absent', () => {
    expect(
      attentionReason(
        {
          urgency: Number.NaN,
          wantsHuman: null,
          upset: Number.NaN,
          callback: null,
        },
        ALL_ON
      )
    ).toBeNull();
  });
});
