import { describe, expect, it } from 'vitest';
import {
  matchTypedReply,
  normaliseReplyText,
  parseOrdinal,
  replyOptionsForNode,
  type ReplyOption,
} from './typed-reply';

const opt = (
  reply_id: string,
  title: string,
  description?: string
): ReplyOption => ({
  reply_id,
  title,
  description,
  next_node_key: `next_${reply_id}`,
});

const BUTTONS = [
  opt('quote', 'Get a quote'),
  opt('compare', 'Compare'),
  opt('agent', 'Talk to us'),
];

const match = (options: ReplyOption[], text: string) => {
  const m = matchTypedReply(options, text);
  return m ? { id: m.option.reply_id, by: m.by, index: m.index } : null;
};

describe('replyOptionsForNode', () => {
  it('reads buttons in order', () => {
    expect(
      replyOptionsForNode({
        node_type: 'send_buttons',
        config: {
          text: 'Pick',
          buttons: [
            { reply_id: 'a', title: 'A', next_node_key: 'na' },
            { reply_id: 'b', title: 'B', next_node_key: 'nb' },
          ],
        },
      })
    ).toEqual([
      { reply_id: 'a', title: 'A', next_node_key: 'na' },
      { reply_id: 'b', title: 'B', next_node_key: 'nb' },
    ]);
  });

  it('flattens list rows across sections, keeping descriptions', () => {
    const options = replyOptionsForNode({
      node_type: 'send_list',
      config: {
        text: 'Pick',
        button_label: 'Menu',
        sections: [
          {
            title: 'Cards',
            rows: [{ reply_id: 'c1', title: 'Gold', next_node_key: 'g' }],
          },
          {
            title: 'Loans',
            rows: [
              {
                reply_id: 'l1',
                title: 'Personal',
                description: 'Up to 250k',
                next_node_key: 'p',
              },
            ],
          },
        ],
      },
    });
    expect(options?.map((o) => o.reply_id)).toEqual(['c1', 'l1']);
    expect(options?.[1]?.description).toBe('Up to 250k');
  });

  it('is null for a node that offers no options', () => {
    expect(
      replyOptionsForNode({ node_type: 'collect_input', config: {} })
    ).toBeNull();
  });
});

describe('normaliseReplyText', () => {
  it('folds case, Arabic diacritics and tatweel, emoji, spacing and edge punctuation', () => {
    expect(normaliseReplyText('  GET   a Quote!! ')).toBe('get a quote');
    expect(normaliseReplyText('نَعَم')).toBe('نعم');
    expect(normaliseReplyText('نعـــم')).toBe('نعم');
    expect(normaliseReplyText('👍 Compare 🙏🏽')).toBe('compare');
    expect(normaliseReplyText('"Talk to us."')).toBe('talk to us');
    expect(normaliseReplyText('٢')).toBe('2');
    expect(normaliseReplyText('۳')).toBe('3');
  });
});

describe('parseOrdinal', () => {
  it.each([
    ['1', 1],
    ['2.', 2],
    ['#2', 2],
    ['2)', 2],
    ['(3)', 3],
    ['option 2', 2],
    ['Option #3', 3],
    ['number 2', 2],
    ['٢', 2],
    ['٢.', 2],
    ['رقم ٣', 3],
    ['2️⃣', 2],
  ])('%s → %i', (text, n) => {
    expect(parseOrdinal(text)).toBe(n);
  });

  it.each([
    '0',
    'two',
    '2 please',
    'option',
    '123',
    '1.5',
    '',
    'no 2',
    'no. 2',
  ])('%s → null', (text) => {
    expect(parseOrdinal(text)).toBeNull();
  });
});

describe('matchTypedReply', () => {
  it('matches a label after normalising', () => {
    expect(match(BUTTONS, 'get a quote')).toEqual({
      id: 'quote',
      by: 'label',
      index: 0,
    });
    expect(match(BUTTONS, 'COMPARE!')).toMatchObject({ id: 'compare' });
    expect(match(BUTTONS, '  talk   to us 🙂')).toMatchObject({ id: 'agent' });
  });

  it('matches Arabic labels without diacritics or tatweel', () => {
    const ar = [opt('yes', 'نَعَم'), opt('no', 'لا')];
    expect(match(ar, 'نعـم')).toEqual({ id: 'yes', by: 'label', index: 0 });
  });

  it('matches a list row by its description when no title matches', () => {
    const rows = [opt('p', 'Personal', 'Up to 250k'), opt('h', 'Home')];
    expect(match(rows, 'up to 250k')).toEqual({
      id: 'p',
      by: 'label',
      index: 0,
    });
  });

  it('matches an emoji-only label by its emoji', () => {
    expect(match([opt('up', '👍'), opt('down', '👎')], '👎')).toEqual({
      id: 'down',
      by: 'label',
      index: 1,
    });
  });

  it('matches each ordinal form within range', () => {
    for (const t of ['2', '2.', '#2', 'option 2', '٢']) {
      expect(match(BUTTONS, t)).toEqual({
        id: 'compare',
        by: 'number',
        index: 1,
      });
    }
    expect(match(BUTTONS, '3')).toMatchObject({ id: 'agent', by: 'number' });
  });

  it('is null out of range', () => {
    expect(match(BUTTONS, '4')).toBeNull();
    expect(match(BUTTONS, '0')).toBeNull();
  });

  it('is null for an ambiguous label', () => {
    expect(match([opt('a', 'Yes'), opt('b', 'yes!')], 'yes')).toBeNull();
    // A title of one option equal to another's description: the title wins.
    expect(
      match([opt('a', 'Gold'), opt('b', 'Card', 'Gold')], 'gold')
    ).toMatchObject({ id: 'a' });
    // Two descriptions alike: ambiguous.
    expect(
      match([opt('a', 'A', 'Same'), opt('b', 'B', 'Same')], 'same')
    ).toBeNull();
  });

  it('prefers a label over an ordinal, and skips ordinals when labels are numbers', () => {
    const amounts = [opt('ten', '10'), opt('twenty', '20'), opt('two', '2')];
    expect(match(amounts, '2')).toEqual({ id: 'two', by: 'label', index: 2 });
    expect(match(amounts, '1')).toBeNull();
  });

  it('is null for free text and empty input', () => {
    expect(match(BUTTONS, 'yes the second one')).toBeNull();
    expect(match(BUTTONS, '   ')).toBeNull();
    expect(match([], '1')).toBeNull();
  });
});
