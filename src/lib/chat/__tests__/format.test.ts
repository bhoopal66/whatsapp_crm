import { describe, expect, it } from 'vitest';

import { serializeDraft } from '../composer';
import {
  applyFormat,
  formatShortcut,
  insertAtSelection,
  parseBody,
  parseInline,
  plainText,
  previewSegments,
  trimUrl,
  type Inline,
} from '../format';

const SARA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const people = [{ userId: SARA, fullName: 'Sara Ahmed' }];
const inl = (s: string) => parseInline(s, people);
const txt = (text: string): Inline => ({ type: 'text', text });
const links = (s: string) =>
  JSON.stringify(inl(s))
    .match(/"href":"[^"]*"/g)
    ?.map((h) => h.slice(8, -1)) ?? [];

describe('inline formatting', () => {
  it('parses bold, italic, strike and code', () => {
    expect(inl('*a*')).toEqual([{ type: 'bold', children: [txt('a')] }]);
    expect(inl('_a_')).toEqual([{ type: 'italic', children: [txt('a')] }]);
    expect(inl('~a~')).toEqual([{ type: 'strike', children: [txt('a')] }]);
    expect(inl('`a`')).toEqual([{ type: 'code', text: 'a' }]);
  });

  it('keeps surrounding text', () => {
    expect(inl('say *hi* now')).toEqual([
      txt('say '),
      { type: 'bold', children: [txt('hi')] },
      txt(' now'),
    ]);
  });

  it('nests *_both_*', () => {
    expect(inl('*_both_*')).toEqual([
      {
        type: 'bold',
        children: [{ type: 'italic', children: [txt('both')] }],
      },
    ]);
  });

  it('opens after punctuation and closes before it', () => {
    expect(inl('(*a*).')).toEqual([
      txt('('),
      { type: 'bold', children: [txt('a')] },
      txt(').'),
    ]);
  });

  it.each(['2*3*4', 'snake_case_name', 'a~b', 'a~b~c', 'x_y_'])(
    'leaves %s literal',
    (s) => expect(inl(s)).toEqual([txt(s)])
  );

  it('leaves unmatched markers literal', () => {
    expect(inl('*open only')).toEqual([txt('*open only')]);
    expect(inl('a * b * c')).toEqual([txt('a * b * c')]);
    expect(inl('**')).toEqual([txt('**')]);
  });

  it('needs a non-space inside the markers', () => {
    expect(inl('* a*')).toEqual([txt('* a*')]);
    expect(inl('*a *')).toEqual([txt('*a *')]);
  });

  it('never spans lines', () => {
    expect(parseBody('*a\nb*', people)).toEqual([
      {
        type: 'paragraph',
        content: [txt('*a'), { type: 'break' }, txt('b*')],
      },
    ]);
  });

  it('keeps markers literal inside code', () => {
    expect(inl('`*not bold* _x_`')).toEqual([
      { type: 'code', text: '*not bold* _x_' },
    ]);
  });

  it('keeps links and mentions literal inside code', () => {
    expect(inl(`\`https://a.io <@${SARA}>\``)).toEqual([
      { type: 'code', text: `https://a.io <@${SARA}>` },
    ]);
  });

  it('formats Arabic text', () => {
    expect(inl('*مرحبا* بك')).toEqual([
      { type: 'bold', children: [txt('مرحبا')] },
      txt(' بك'),
    ]);
    expect(inl('_شكرا_،')).toEqual([
      { type: 'italic', children: [txt('شكرا')] },
      txt('،'),
    ]);
  });
});

describe('mentions', () => {
  it('resolves a person by name', () => {
    expect(inl(`hi <@${SARA}>`)).toEqual([
      txt('hi '),
      { type: 'mention', userId: SARA, name: 'Sara Ahmed' },
    ]);
  });

  it('a mention inside bold', () => {
    expect(inl(`*<@${SARA}>*`)).toEqual([
      {
        type: 'bold',
        children: [{ type: 'mention', userId: SARA, name: 'Sara Ahmed' }],
      },
    ]);
  });

  it('an unknown person has a null name', () => {
    const other = SARA.replace('0f8', 'aaa');
    expect(inl(`<@${other}>`)).toEqual([
      { type: 'mention', userId: other, name: null },
    ]);
  });

  it('@channel and @here, also in bold', () => {
    expect(inl('*@here* and @channel')).toEqual([
      { type: 'bold', children: [{ type: 'broadcast', kind: 'here' }] },
      txt(' and '),
      { type: 'broadcast', kind: 'channel' },
    ]);
  });

  it('_@here_ is no broadcast, as the SQL records none (_ is a word char)', () => {
    expect(inl('_@here_')).toEqual([
      { type: 'italic', children: [txt('@here')] },
    ]);
  });
});

describe('links', () => {
  it('links http and https', () => {
    expect(links('see https://a.io/x and http://b.io')).toEqual([
      'https://a.io/x',
      'http://b.io',
    ]);
  });

  it.each([
    ['https://a.io.', 'https://a.io'],
    ['https://a.io/x?,', 'https://a.io/x'],
    ['https://a.io!;:', 'https://a.io'],
    ['(https://a.io/x)', 'https://a.io/x'],
    [
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ],
  ])('trims %s to %s', (s, href) => expect(links(s)).toEqual([href]));

  it.each([
    'javascript:alert(1)',
    'www.x.com',
    'data:text/html,hi',
    'ftp://x.com',
    'https://',
  ])('never links %s', (s) => expect(links(s)).toEqual([]));

  it('keeps underscores and asterisks in URLs', () => {
    expect(inl('https://a.io/snake_case_x')).toEqual([
      { type: 'link', href: 'https://a.io/snake_case_x' },
    ]);
    expect(inl('*https://a.io*')).toEqual([
      { type: 'bold', children: [{ type: 'link', href: 'https://a.io' }] },
    ]);
  });

  it('trimUrl returns null for a bare scheme', () => {
    expect(trimUrl('https://.')).toBeNull();
  });
});

describe('blocks', () => {
  it('fenced code is literal and multi-line', () => {
    expect(parseBody('before\n```\n*x*\n  y\n```\nafter', people)).toEqual([
      { type: 'paragraph', content: [txt('before')] },
      { type: 'code', text: '*x*\n  y' },
      { type: 'paragraph', content: [txt('after')] },
    ]);
  });

  it('a one-line fence', () => {
    expect(parseBody('```a *b*```', people)).toEqual([
      { type: 'code', text: 'a *b*' },
    ]);
  });

  it('an unclosed fence stays text', () => {
    expect(parseBody('```\nx', people)).toEqual([
      {
        type: 'paragraph',
        content: [txt('```'), { type: 'break' }, txt('x')],
      },
    ]);
  });

  it('quotes join consecutive lines', () => {
    expect(parseBody('> a\n> *b*\nc', people)).toEqual([
      {
        type: 'quote',
        content: [
          txt('a'),
          { type: 'break' },
          { type: 'bold', children: [txt('b')] },
        ],
      },
      { type: 'paragraph', content: [txt('c')] },
    ]);
  });

  it('">5" is not a quote', () => {
    expect(parseBody('>5 items', people)[0].type).toBe('paragraph');
  });

  it('bullets with -, * and •', () => {
    expect(parseBody('- a\n* b\n• c', people)).toEqual([
      { type: 'bullets', items: [[txt('a')], [txt('b')], [txt('c')]] },
    ]);
  });

  it('numbered lists keep their start', () => {
    expect(parseBody('3. a\n4. b', people)).toEqual([
      { type: 'numbered', start: 3, items: [[txt('a')], [txt('b')]] },
    ]);
  });

  it('paragraphs split at blank lines and keep line breaks', () => {
    expect(parseBody('a\nb\n\nc', people)).toEqual([
      { type: 'paragraph', content: [txt('a'), { type: 'break' }, txt('b')] },
      { type: 'paragraph', content: [txt('c')] },
    ]);
  });
});

describe('plainText and previewSegments', () => {
  it('removes markers and names mentions', () => {
    expect(plainText(`*hi* <@${SARA}>, _see_ \`x\``, people)).toBe(
      'hi @Sara Ahmed, see x'
    );
  });

  it('lists and quotes read as lines', () => {
    expect(plainText('> q\n- a\n1. b\n```\nc\n```', people)).toBe(
      'q\n• a\n1. b\nc'
    );
  });

  it('an unknown mention uses the fallback', () => {
    const other = SARA.replace('0f8', 'aaa');
    expect(plainText(`<@${other}>`, people, 'Someone')).toBe('@Someone');
  });

  it('previewSegments keeps mention segments and merges text', () => {
    expect(previewSegments(`*a* b <@${SARA}>`, people)).toEqual([
      { type: 'text', text: 'a b ' },
      { type: 'mention', userId: SARA, name: 'Sara Ahmed' },
    ]);
  });
});

describe('formatShortcut', () => {
  const k = (
    key: string,
    o: Partial<{
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    }> = {}
  ) =>
    formatShortcut({
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...o,
    });
  it('maps the four shortcuts', () => {
    expect(k('b')).toBe('bold');
    expect(k('i', { ctrlKey: false, metaKey: true })).toBe('italic');
    expect(k('X', { shiftKey: true })).toBe('strike');
    expect(k('e')).toBe('code');
  });
  it('ignores other keys and plain typing', () => {
    expect(k('x')).toBeNull();
    expect(k('b', { ctrlKey: false })).toBeNull();
    expect(k('b', { altKey: true })).toBeNull();
  });
});

describe('applyFormat', () => {
  const d = (text: string) => ({ text, picked: [] });

  it('wraps the selection and keeps it selected inside the markers', () => {
    expect(applyFormat(d('say hi now'), 4, 6, 'bold')).toEqual({
      draft: d('say *hi* now'),
      selStart: 5,
      selEnd: 7,
    });
  });

  it('inserts the pair with the caret between when nothing is selected', () => {
    expect(applyFormat(d('ab'), 1, 1, 'italic')).toEqual({
      draft: d('a__b'),
      selStart: 2,
      selEnd: 2,
    });
  });

  it('trims whitespace off the selection edges', () => {
    expect(applyFormat(d('a word b'), 1, 7, 'strike').draft.text).toBe(
      'a ~word~ b'
    );
  });

  it('unwraps an already wrapped selection', () => {
    expect(applyFormat(d('say *hi* now'), 5, 7, 'bold').draft.text).toBe(
      'say hi now'
    );
    expect(applyFormat(d('say *hi* now'), 4, 8, 'bold').draft.text).toBe(
      'say hi now'
    );
  });

  it('wraps each line of a multi-line selection', () => {
    expect(applyFormat(d('a\nb'), 0, 3, 'code').draft.text).toBe('`a`\n`b`');
  });

  it('nests: bold then italic', () => {
    const b = applyFormat(d('x'), 0, 1, 'bold');
    const r = applyFormat(b.draft, b.selStart, b.selEnd, 'italic');
    expect(r.draft.text).toBe('*_x_*');
    expect(parseInline(r.draft.text, people)).toEqual([
      { type: 'bold', children: [{ type: 'italic', children: [txt('x')] }] },
    ]);
  });

  it('prefixes and un-prefixes lines for quote and bullets', () => {
    expect(applyFormat(d('a\nb\nc'), 0, 3, 'quote').draft.text).toBe(
      '> a\n> b\nc'
    );
    expect(applyFormat(d('> a\n> b'), 2, 2, 'quote').draft.text).toBe('a\n> b');
    expect(applyFormat(d('x'), 1, 1, 'bullets')).toEqual({
      draft: d('- x'),
      selStart: 3,
      selEnd: 3,
    });
  });

  it('keeps a picked mention whole and serializable', () => {
    const draft = {
      text: 'ask @Sara Ahmed now',
      picked: [{ userId: SARA, label: 'Sara Ahmed' }],
    };
    // Selection starts inside the label: it widens to the whole label.
    const r = applyFormat(draft, 8, 15, 'bold');
    expect(r.draft.text).toBe('ask *@Sara Ahmed* now');
    expect(r.draft.picked).toEqual(draft.picked);
    expect(serializeDraft(r.draft.text, r.draft.picked)).toBe(
      `ask *<@${SARA}>* now`
    );
    expect(
      parseInline(serializeDraft(r.draft.text, r.draft.picked), people)[1]
    ).toEqual({
      type: 'bold',
      children: [{ type: 'mention', userId: SARA, name: 'Sara Ahmed' }],
    });
  });
});

describe('insertAtSelection', () => {
  const picked = [{ userId: SARA, label: 'Sara Ahmed' }];
  const token = `<@${SARA}>`;

  it('inserts at the caret and puts the caret after it', () => {
    const r = insertAtSelection({ text: 'hi there', picked: [] }, 2, 2, '👋');
    expect(r.draft.text).toBe('hi👋 there');
    expect(r.caret).toBe(2 + '👋'.length);
  });

  it('replaces a selection, in either direction', () => {
    const d = { text: 'good job', picked: [] };
    expect(insertAtSelection(d, 5, 8, '👍').draft.text).toBe('good 👍');
    expect(insertAtSelection(d, 8, 5, '👍').draft.text).toBe('good 👍');
  });

  it('moves a caret inside a picked label to its end', () => {
    const draft = { text: 'ask @Sara Ahmed now', picked };
    const r = insertAtSelection(draft, 8, 8, '🙏');
    expect(r.draft.text).toBe('ask @Sara Ahmed🙏 now');
    expect(r.caret).toBe(15 + '🙏'.length);
    expect(r.draft.picked).toEqual(picked);
    expect(serializeDraft(r.draft.text, r.draft.picked)).toBe(
      `ask ${token}🙏 now`
    );
  });

  it('widens a selection edge inside a label to the whole label', () => {
    const draft = { text: 'ask @Sara Ahmed now', picked };
    expect(insertAtSelection(draft, 10, 19, '✅').draft.text).toBe('ask ✅');
  });

  it('keeps a word character off either end of a label', () => {
    const draft = { text: '@Sara Ahmed', picked };
    const after = insertAtSelection(draft, 11, 11, 'x');
    expect(after.draft.text).toBe('@Sara Ahmed x');
    expect(serializeDraft(after.draft.text, picked)).toBe(`${token} x`);
    const before = insertAtSelection(draft, 0, 0, 'x');
    expect(before.draft.text).toBe('x @Sara Ahmed');
    expect(serializeDraft(before.draft.text, picked)).toBe(`x ${token}`);
  });
});
