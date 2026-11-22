import { describe, expect, it } from 'vitest';

import { captionCode } from './case-number';
import { classifyCaseRef, isLookupReady, normaliseCaseRef } from './case-ref';

describe('classifyCaseRef', () => {
  it('says nothing for an empty box', () => {
    expect(classifyCaseRef('')).toEqual({ kind: 'empty' });
    expect(classifyCaseRef('   ')).toEqual({ kind: 'empty' });
  });

  it('accepts a full case number, in any case and with spaces', () => {
    expect(classifyCaseRef(' tc-26-04271-rak ')).toEqual({
      kind: 'case_number',
      ref: 'TC-26-04271-RAK',
    });
    expect(classifyCaseRef('TC-26-04271-RAK3').kind).toBe('case_number');
  });

  it('accepts a caption code whose check character holds', () => {
    const code = captionCode(4271, 'RAK');
    expect(classifyCaseRef(code.toLowerCase())).toEqual({
      kind: 'caption',
      ref: code,
    });
  });

  it('flags a code-shaped text with a wrong check character', () => {
    const code = captionCode(4271, 'RAK');
    const wrong = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(classifyCaseRef(wrong).kind).toBe('bad_check');
  });

  it('waits while it could still become a reference', () => {
    expect(classifyCaseRef('4271').kind).toBe('incomplete');
    expect(classifyCaseRef('TC-26-').kind).toBe('incomplete');
  });

  it('rejects text that cannot be one', () => {
    expect(classifyCaseRef('hello world!').kind).toBe('invalid');
    expect(classifyCaseRef('A'.repeat(30)).kind).toBe('invalid');
  });

  it('is ready to look up only for the two full shapes', () => {
    expect(isLookupReady(classifyCaseRef('TC-26-04271-RAK'))).toBe(true);
    expect(isLookupReady(classifyCaseRef('4271'))).toBe(false);
    expect(isLookupReady({ kind: 'empty' })).toBe(false);
  });

  it('normalises', () => {
    expect(normaliseCaseRef(' tc 26 ')).toBe('TC26');
  });
});
