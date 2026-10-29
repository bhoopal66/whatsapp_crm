import { describe, expect, it } from 'vitest';
import { INTENTS } from '@/lib/typesafe/questions/triage';
import {
  INSIGHT_INTENT_KEYS,
  TAG_SUGGEST_MIN_P,
  isUpset,
  leadBand,
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
