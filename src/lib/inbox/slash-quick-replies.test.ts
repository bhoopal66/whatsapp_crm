import { describe, expect, it } from 'vitest';

import {
  applySlashInsert,
  detectSlashToken,
  matchQuickReplies,
  moveHighlight,
  quickReplyShortcut,
  SLASH_QUERY_MAX,
} from './slash-quick-replies';

const QR = [
  { title: 'Welcome message', content_text: 'Hello! How can we help?' },
  { title: 'Bank documents', content_text: 'Please send your trade licence.' },
  { title: 'Thanks', content_text: 'Thank you for your time.' },
  { title: 'Follow up', content_text: null },
  { title: 'Café hours', content_text: 'We open at 9.' },
];

describe('detectSlashToken', () => {
  it('finds "/" at the start with the caret on the first line', () => {
    expect(detectSlashToken('/', 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(detectSlashToken('/wel', 4)).toEqual({
      query: 'wel',
      start: 0,
      end: 4,
    });
  });

  it('runs to the end of the first line', () => {
    expect(detectSlashToken('/wel\nmore', 2)).toEqual({
      query: 'wel',
      start: 0,
      end: 4,
    });
  });

  it('allows spaces inside the query', () => {
    expect(detectSlashToken('/welcome mes', 12)?.query).toBe('welcome mes');
  });

  it('ignores text not starting with a slash', () => {
    expect(detectSlashToken('hi /wel', 7)).toBeNull();
    expect(detectSlashToken(' /wel', 5)).toBeNull();
    expect(detectSlashToken('', 0)).toBeNull();
  });

  it('ignores a caret before the slash or on a later line', () => {
    expect(detectSlashToken('/wel', 0)).toBeNull();
    expect(detectSlashToken('/wel\nmore', 7)).toBeNull();
  });

  it('treats a missing caret as the end of the first line', () => {
    expect(detectSlashToken('/wel', null)?.query).toBe('wel');
  });

  it('ignores "/ " and over-long queries', () => {
    expect(detectSlashToken('/ hello', 3)).toBeNull();
    const long = `/${'a'.repeat(SLASH_QUERY_MAX + 1)}`;
    expect(detectSlashToken(long, long.length)).toBeNull();
  });
});

describe('quickReplyShortcut', () => {
  it('joins title words with dashes in lower case', () => {
    expect(quickReplyShortcut(QR[0])).toBe('welcome-message');
    expect(quickReplyShortcut(QR[4])).toBe('cafe-hours');
  });
});

describe('matchQuickReplies', () => {
  const titles = (q: string, limit?: number) =>
    matchQuickReplies(QR, q, limit).map((x) => x.title);

  it('returns everything in order for an empty query', () => {
    expect(titles('')).toEqual(QR.map((x) => x.title));
    expect(titles('', 2)).toEqual(['Welcome message', 'Bank documents']);
  });

  it('matches the shortcut, with or without dashes', () => {
    expect(titles('welcome-mes')).toEqual(['Welcome message']);
    expect(titles('welcome mes')).toEqual(['Welcome message']);
  });

  it('matches a title word and the body', () => {
    expect(titles('documents')).toEqual(['Bank documents']);
    expect(titles('licence')).toEqual(['Bank documents']);
  });

  it('ranks shortcut and title hits above body hits', () => {
    // "thank" starts the Thanks shortcut and only appears in a body
    // elsewhere; "help" is in a body only.
    expect(titles('thank')).toEqual(['Thanks']);
    expect(titles('t')[0]).toBe('Thanks');
    expect(titles('help')).toEqual(['Welcome message']);
  });

  it('ignores case and accents', () => {
    expect(titles('CAFE')).toEqual(['Café hours']);
  });

  it('copes with a missing body and returns nothing for no match', () => {
    expect(titles('follow')).toEqual(['Follow up']);
    expect(titles('zzz')).toEqual([]);
  });
});

describe('applySlashInsert', () => {
  it('replaces the token and puts the caret after the reply', () => {
    const token = detectSlashToken('/wel', 4)!;
    expect(applySlashInsert('/wel', token, 'Hello!')).toEqual({
      text: 'Hello!',
      caret: 6,
    });
  });

  it('keeps the lines after the token', () => {
    const text = '/wel\nsecond line';
    const token = detectSlashToken(text, 4)!;
    expect(applySlashInsert(text, token, 'Hello!')).toEqual({
      text: 'Hello!\nsecond line',
      caret: 6,
    });
  });
});

describe('moveHighlight', () => {
  it('wraps both ways', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it('starts from the top or bottom with nothing highlighted', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
  });

  it('is -1 for an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});
