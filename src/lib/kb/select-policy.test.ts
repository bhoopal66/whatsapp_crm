import { describe, expect, it } from 'vitest';
import {
  decideApprovedAnswer,
  describeKbSelection,
  KB_HANDOFF_THRESHOLD,
  type KbCandidate,
  type KbSelectScores,
} from './select-policy';

const entry = (ref: string, over: Partial<KbCandidate> = {}): KbCandidate => ({
  id: `id-${ref}`,
  ref,
  question: `question ${ref}`,
  answerEn: `English answer ${ref}`,
  answerAr: `جواب ${ref}`,
  handoffAfter: false,
  ...over,
});

const shortlist = [entry('KB-010'), entry('KB-011'), entry('KB-012')];
const calm = { pricing: 0.1, legal: 0.1, angry: 0.1 };

function judgment(
  scores: [answersFully: number, sameIntent: number][],
  handoff: Partial<KbSelectScores['handoff']> = {}
): KbSelectScores {
  return {
    handoff: { ...calm, ...handoff },
    candidates: scores.map(([answersFully, sameIntent], index) => ({
      index,
      answersFully,
      sameIntent,
    })),
  };
}

const decide = (
  j: KbSelectScores,
  over: Partial<Parameters<typeof decideApprovedAnswer>[0]> = {}
) =>
  decideApprovedAnswer({
    language: 'en',
    judgment: j,
    candidates: shortlist,
    minScore: 0.8,
    ...over,
  });

describe('decideApprovedAnswer — hand-off conditions', () => {
  it('uses a threshold of 0.5', () => {
    expect(KB_HANDOFF_THRESHOLD).toBe(0.5);
  });

  it.each(['pricing', 'legal', 'angry'] as const)(
    'hands off when %s reaches the threshold exactly',
    (k) => {
      const d = decide(judgment([[0.99, 0.99]], { [k]: 0.5 }));
      expect(d).toEqual({
        kind: 'handoff',
        reason: 'kb',
        detail: `Hand-off condition: ${k} (0.50)`,
      });
    }
  );

  it('does not hand off just below the threshold', () => {
    const d = decide(
      judgment([[0.99, 0.99]], { pricing: 0.49, legal: 0.49, angry: 0.49 })
    );
    expect(d.kind).toBe('send');
  });

  it('names every condition raised', () => {
    const d = decide(judgment([[0.99, 0.99]], { pricing: 0.7, angry: 0.91 }));
    expect(d).toMatchObject({
      reason: 'kb',
      detail: 'Hand-off condition: pricing (0.70), angry (0.91)',
    });
  });

  it('wins over a perfect answer and an unsupported language', () => {
    const d = decide(judgment([[1, 1]], { legal: 0.8 }), { language: 'other' });
    expect(d).toMatchObject({ kind: 'handoff', reason: 'kb' });
  });
});

describe('decideApprovedAnswer — scoring', () => {
  it('scores a candidate by the weaker of its two figures', () => {
    // fully answers, but not what was asked: must not be sent
    const d = decide(judgment([[0.95, 0.3]]));
    expect(d).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'Best approved answer KB-010 scored 0.30 (needs 0.80)',
    });
    const e = decide(judgment([[0.3, 0.95]]));
    expect(e).toMatchObject({ kind: 'handoff', reason: 'no_knowledge' });
  });

  it('picks the highest score', () => {
    const d = decide(
      judgment([
        [0.85, 0.99],
        [0.97, 0.93],
        [0.99, 0.5],
      ])
    );
    expect(d).toMatchObject({ kind: 'send', entry: { ref: 'KB-011' } });
    expect(d.kind === 'send' && d.score).toBeCloseTo(0.93);
  });

  it('breaks a tie in shortlist order', () => {
    const d = decide(
      judgment([
        [0.5, 0.5],
        [0.9, 0.95],
        [0.95, 0.9],
      ])
    );
    expect(d).toMatchObject({ kind: 'send', entry: { ref: 'KB-011' } });
  });

  it('breaks a tie in shortlist order whatever order the figures come in', () => {
    const j = judgment([
      [0.5, 0.5],
      [0.9, 0.95],
      [0.95, 0.9],
    ]);
    j.candidates.reverse();
    expect(decide(j)).toMatchObject({ entry: { ref: 'KB-011' } });
  });

  it('sends a candidate scoring exactly minScore', () => {
    const d = decide(judgment([[0.8, 0.9]]));
    expect(d).toMatchObject({ kind: 'send', score: 0.8 });
  });

  it('hands off just below minScore, without rounding up to it', () => {
    const d = decide(judgment([[0.799, 0.9]]));
    expect(d).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'Best approved answer KB-010 scored 0.79 (needs 0.80)',
    });
  });

  it('hands off when nothing was judged', () => {
    expect(decide(judgment([]))).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'No approved answer matched',
    });
    expect(decide(judgment([[1, 1]]), { candidates: [] })).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'No approved answer matched',
    });
  });

  it('ignores figures for a position outside the shortlist', () => {
    const j: KbSelectScores = {
      handoff: calm,
      candidates: [
        { index: 7, answersFully: 1, sameIntent: 1 },
        { index: 1, answersFully: 0.85, sameIntent: 0.9 },
      ],
    };
    expect(decide(j)).toMatchObject({
      kind: 'send',
      entry: { ref: 'KB-011' },
    });
  });
});

describe('decideApprovedAnswer — language', () => {
  const best = judgment([[0.95, 0.95]]);

  it.each(['en', 'mixed', 'unknown'] as const)(
    'sends the English answer verbatim for %s',
    (language) => {
      const d = decide(best, { language });
      expect(d).toEqual({
        kind: 'send',
        entry: shortlist[0],
        text: 'English answer KB-010',
        score: 0.95,
        thenHandOff: false,
      });
    }
  );

  it('sends the Arabic answer for an Arabic message', () => {
    expect(decide(best, { language: 'ar' })).toMatchObject({
      kind: 'send',
      text: 'جواب KB-010',
    });
  });

  it('hands off an Arabic message when the answer has no Arabic text', () => {
    const d = decide(best, {
      language: 'ar',
      candidates: [entry('KB-010', { answerAr: null })],
    });
    expect(d).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'No approved Arabic answer for KB-010',
    });
    expect(
      decide(best, {
        language: 'ar',
        candidates: [entry('KB-010', { answerAr: '  ' })],
      })
    ).toMatchObject({ kind: 'handoff', reason: 'no_knowledge' });
  });

  it('hands off a message in another language', () => {
    expect(decide(best, { language: 'other' })).toEqual({
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: "No approved answer in the customer's language for KB-010",
    });
  });

  it('keeps the answer text exactly as approved', () => {
    const text = '  Line one.\nLine two.  ';
    expect(
      decide(best, { candidates: [entry('KB-010', { answerEn: text })] })
    ).toMatchObject({ kind: 'send', text });
  });
});

describe('decideApprovedAnswer — then hand off', () => {
  it('carries the entry’s handoff_after flag', () => {
    const d = decide(judgment([[0.9, 0.9]]), {
      candidates: [entry('KB-020', { handoffAfter: true })],
    });
    expect(d).toMatchObject({ kind: 'send', thenHandOff: true });
  });
});

describe('describeKbSelection', () => {
  it('names the entry and its score', () => {
    expect(describeKbSelection({ entry: { ref: 'KB-010' }, score: 0.91 })).toBe(
      'Approved answer KB-010 (0.91)'
    );
  });

  it('describes a send decision directly', () => {
    const d = decide(judgment([[0.934, 0.95]]));
    if (d.kind !== 'send') throw new Error('expected send');
    expect(describeKbSelection(d)).toBe('Approved answer KB-010 (0.93)');
  });
});
