import { describe, expect, it } from 'vitest';

import {
  replayDropsChange,
  uploadSignature,
  type UploadAttempt,
} from './upload-replay';

const a: UploadAttempt = {
  tags: { kind: 'new_case', bankCode: 'A', note: null },
  caption: ' x ',
  file: { name: 'f.pdf', size: 3 },
};

describe('uploadSignature', () => {
  it('ignores key order and caption padding', () => {
    const b: UploadAttempt = {
      tags: { note: null, bankCode: 'A', kind: 'new_case' },
      caption: 'x',
      file: { name: 'f.pdf', size: 3 },
    };
    expect(uploadSignature(a)).toBe(uploadSignature(b));
  });
  it('changes with a tag, the caption or the file', () => {
    const s = uploadSignature(a);
    expect(
      uploadSignature({ ...a, tags: { ...a.tags, bankCode: 'B' } })
    ).not.toBe(s);
    expect(uploadSignature({ ...a, caption: 'y' })).not.toBe(s);
    expect(uploadSignature({ ...a, file: null })).not.toBe(s);
  });
});

describe('replayDropsChange', () => {
  it('flags a replay of a different first attempt', () => {
    expect(replayDropsChange(true, 'first', 'second')).toBe(true);
  });
  it('is quiet for an identical retry, a fresh result or no record', () => {
    expect(replayDropsChange(true, 'same', 'same')).toBe(false);
    expect(replayDropsChange(false, 'first', 'second')).toBe(false);
    expect(replayDropsChange(true, null, 'second')).toBe(false);
  });
});
