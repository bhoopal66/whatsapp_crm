import { describe, expect, it } from 'vitest';

import {
  appendPage,
  fileKind,
  isCurrentFilesRequest,
  lightboxKeyDelta,
  nextFilesRequest,
  opensInTab,
  pageCut,
  stepIndex,
  tabKind,
  type FilesRequest,
} from '../files';

describe('fileKind', () => {
  it('reads the mime type first', () => {
    expect(fileKind('application/pdf', 'x.bin')).toBe('pdf');
    expect(
      fileKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'a'
      )
    ).toBe('spreadsheet');
    expect(fileKind('text/csv', 'a')).toBe('spreadsheet');
    expect(
      fileKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'a'
      )
    ).toBe('document');
    expect(fileKind('application/msword', 'a')).toBe('document');
    expect(fileKind('application/vnd.ms-powerpoint', 'a')).toBe('presentation');
    expect(fileKind('application/zip', 'a')).toBe('archive');
    expect(fileKind('application/x-7z-compressed', 'a')).toBe('archive');
    expect(fileKind('text/plain; charset=utf-8', 'a')).toBe('text');
  });

  it('falls back to the extension when the mime says nothing', () => {
    expect(fileKind('application/octet-stream', 'Q3.XLSX')).toBe('spreadsheet');
    expect(fileKind('', 'deck.pptx')).toBe('presentation');
    expect(fileKind('application/octet-stream', 'brief.docx')).toBe('document');
    expect(fileKind('application/octet-stream', 'logs.tar.gz')).toBe('archive');
    expect(fileKind('application/octet-stream', 'scan.pdf')).toBe('pdf');
    expect(fileKind('application/octet-stream', 'notes.md')).toBe('text');
  });

  it('is other when neither helps', () => {
    expect(fileKind('application/octet-stream', 'blob')).toBe('other');
    expect(fileKind('application/octet-stream', '.hidden')).toBe('other');
    expect(fileKind('application/octet-stream', 'x.constructor')).toBe('other');
    expect(fileKind('application/x-msdownload', 'setup.exe')).toBe('other');
  });

  it('opens only PDFs and text in a tab', () => {
    expect(opensInTab('pdf')).toBe(true);
    expect(opensInTab('text')).toBe(true);
    expect(opensInTab('spreadsheet')).toBe(false);
    expect(opensInTab('other')).toBe(false);
  });
});

describe('lightbox stepping', () => {
  it('steps within the list and stops at either end', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, -1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBeNull();
    expect(stepIndex(0, 3, -1)).toBeNull();
    expect(stepIndex(0, 1, 1)).toBeNull();
    expect(stepIndex(0, 0, 1)).toBeNull();
  });

  it('maps the arrow keys', () => {
    expect(lightboxKeyDelta('ArrowLeft')).toBe(-1);
    expect(lightboxKeyDelta('ArrowRight')).toBe(1);
    expect(lightboxKeyDelta('Escape')).toBe(0);
  });
});

describe('Files panel paging', () => {
  it('asks for no kind on All', () => {
    expect(tabKind('all')).toBeNull();
    expect(tabKind('video')).toBe('video');
  });

  it('appends a page without repeating an attachment', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    expect(appendPage([a, b], [b, c])).toEqual([a, b, c]);
  });
});

describe('pageCut', () => {
  const f = (id: string, createdAt: string) => ({ id, createdAt });
  it('holds back a message straddling the page end', () => {
    const items = [f('a', '3'), f('b', '2'), f('c', '1'), f('d', '1')];
    expect(pageCut(items, true)).toEqual({
      keep: [f('a', '3'), f('b', '2')],
      before: '2',
    });
  });

  it('keeps a page that is all one message, and the last page whole', () => {
    const one = [f('a', '1'), f('b', '1')];
    expect(pageCut(one, true)).toEqual({ keep: one, before: '1' });
    expect(pageCut([f('a', '2'), f('b', '1')], false)).toEqual({
      keep: [f('a', '2'), f('b', '1')],
      before: null,
    });
  });
});

describe('Files panel requests', () => {
  const start: FilesRequest = { tab: 'all', gen: 0 };

  it('drops a Load more on All that lands after switching to Images', () => {
    const more = nextFilesRequest(start, 'all'); // All on screen, Load more
    const images = nextFilesRequest(more, 'image'); // then a tab switch
    expect(isCurrentFilesRequest(more, images)).toBe(false);
    expect(isCurrentFilesRequest(images, images)).toBe(true);
  });

  it('drops it after switching away and back to the same tab', () => {
    const all = nextFilesRequest(start, 'all');
    const back = nextFilesRequest(nextFilesRequest(all, 'image'), 'all');
    expect(back.tab).toBe('all');
    expect(isCurrentFilesRequest(all, back)).toBe(false);
  });

  it('keeps a page asked for under the list still on screen', () => {
    const all = nextFilesRequest(start, 'all');
    expect(isCurrentFilesRequest(all, { ...all })).toBe(true);
  });
});
