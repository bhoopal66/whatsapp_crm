/** Package 026d F4: sanitizeData means candidate text can never forge a DATA marker. */
import { describe, expect, it } from 'vitest';
import type { ModelInput } from './ports';
import {
  DATA_END,
  DATA_START,
  buildUserContent,
  sanitizeData,
} from './prompts';

const draftInput = (over: Partial<ModelInput> = {}): ModelInput => ({
  task: 'draft',
  agent: 'candidate_faq',
  lang: 'en',
  stage: 'cv_review',
  inboundText: 'What does the role involve?',
  history: [],
  intent: 'question_role',
  slots: [],
  ...over,
});

describe('026d F4 sanitizeData: candidate text can never forge a DATA marker', () => {
  const count = (s: string, m: string) => s.split(m).length - 1;
  const once = (inboundText: string, history: string[] = []) => {
    const out = buildUserContent(
      draftInput({
        inboundText,
        history: history.map((text) => ({
          direction: 'in' as const,
          text,
          at: '2026-11-14T09:00:00Z',
        })),
      })
    );
    expect(count(out, DATA_START), inboundText).toBe(1);
    expect(count(out, DATA_END), inboundText).toBe(1);
  };

  it("the angle-run splice 'CANDIDATE_DATA>><<<>' leaves each marker exactly once", () => {
    once('CANDIDATE_DATA>><<<>', ['CANDIDATE_DATA>><<<>']);
    once('<<<<CANDIDATE_DATA>><<<>' + DATA_START + DATA_END);
    const s = sanitizeData('CANDIDATE_DATA>><<<>');
    expect(s).not.toMatch(/[<>]/);
    expect(s).not.toContain('CANDIDATE_DATA');
  });

  it('the marker word is neutralised case-insensitively', () => {
    expect(sanitizeData('candidate_data and Candidate_Data')).toBe(
      'CANDIDATE DATA and CANDIDATE DATA'
    );
  });

  it('fuzz: 200 strings built from marker fragments never yield an extra marker', () => {
    const frags = [
      '<',
      '>',
      '<<',
      '>>',
      '<<<',
      '>>>',
      'CANDIDATE',
      '_DATA',
      'CANDIDATE_DATA',
      'candidate_data',
      'CANDIDATE_',
      'DATA',
      '_',
      ' ',
      'x',
      DATA_START,
      DATA_END,
    ];
    let seed = 26;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i++) {
      const parts: string[] = [];
      const len = 1 + rnd(12);
      for (let j = 0; j < len; j++) parts.push(frags[rnd(frags.length)]!);
      const text = parts.join('');
      once(text, [text]);
      expect(sanitizeData(text)).not.toMatch(/[<>]|CANDIDATE_DATA/i);
    }
  });
});
