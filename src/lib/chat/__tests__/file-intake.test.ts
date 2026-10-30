import { describe, expect, it } from 'vitest';

import {
  carriesFiles,
  isPreviewableImage,
  nextDragDepth,
  pastePlan,
  transferFiles,
  type TransferLike,
} from '../file-intake';

interface F {
  name: string;
}
const a: F = { name: 'a.png' };
const b: F = { name: 'b.pdf' };

const fileItem = (f: F) => ({ kind: 'file', getAsFile: () => f });
const textItem = { kind: 'string', getAsFile: () => null };

function transfer(o: {
  types?: string[];
  files?: F[];
  items?: TransferLike<F>['items'];
  text?: string;
}): TransferLike<F> {
  return {
    types: o.types ?? [],
    files: o.files ?? [],
    items: o.items ?? [],
    getData: (format) => (format === 'text/plain' ? (o.text ?? '') : ''),
  };
}

describe('carriesFiles', () => {
  it('is true only for a drag of files', () => {
    expect(carriesFiles(transfer({ types: ['Files'] }))).toBe(true);
    expect(carriesFiles(transfer({ types: ['text/plain', 'Files'] }))).toBe(
      true
    );
    expect(
      carriesFiles(transfer({ types: ['text/plain', 'text/uri-list'] }))
    ).toBe(false);
    expect(carriesFiles(transfer({}))).toBe(false);
    expect(carriesFiles(null)).toBe(false);
    expect(carriesFiles({ types: null })).toBe(false);
  });
});

describe('transferFiles', () => {
  it('takes the files list when the browser filled it', () => {
    expect(
      transferFiles(transfer({ files: [a, b], items: [fileItem(a)] }))
    ).toEqual([a, b]);
  });

  it('falls back to file items, skipping text items', () => {
    expect(
      transferFiles(transfer({ items: [textItem, fileItem(b), textItem] }))
    ).toEqual([b]);
    expect(
      transferFiles(
        transfer({ items: [{ kind: 'file', getAsFile: () => null }] })
      )
    ).toEqual([]);
  });

  it('is empty without a transfer', () => {
    expect(transferFiles(null)).toEqual([]);
    expect(transferFiles(undefined)).toEqual([]);
    expect(transferFiles({})).toEqual([]);
  });
});

describe('pastePlan', () => {
  it('a screenshot attaches and cancels the browser paste', () => {
    expect(pastePlan(transfer({ files: [a] }))).toEqual({
      files: [a],
      preventDefault: true,
    });
  });

  it('plain text is left to the browser', () => {
    expect(pastePlan(transfer({ text: 'hello', items: [textItem] }))).toEqual({
      files: [],
      preventDefault: false,
    });
    expect(pastePlan(null)).toEqual({ files: [], preventDefault: false });
  });

  it('text copied with an image still pastes; the image attaches', () => {
    expect(pastePlan(transfer({ files: [a], text: 'caption' }))).toEqual({
      files: [a],
      preventDefault: false,
    });
  });
});

describe('nextDragDepth', () => {
  it('counts nested enters and leaves and never goes below zero', () => {
    let d = 0;
    d = nextDragDepth(d, 'enter');
    d = nextDragDepth(d, 'enter');
    d = nextDragDepth(d, 'leave');
    expect(d).toBe(1);
    d = nextDragDepth(d, 'leave');
    expect(d).toBe(0);
    expect(nextDragDepth(0, 'leave')).toBe(0);
  });

  it('a drop ends the drag whatever the count', () => {
    expect(nextDragDepth(3, 'drop')).toBe(0);
  });
});

describe('isPreviewableImage', () => {
  it('previews the common raster images only', () => {
    for (const t of ['image/png', 'image/JPEG', 'image/gif', 'image/webp'])
      expect(isPreviewableImage(t)).toBe(true);
    for (const t of ['image/svg+xml', 'image/heic', 'application/pdf', ''])
      expect(isPreviewableImage(t)).toBe(false);
    expect(isPreviewableImage(null)).toBe(false);
  });
});
