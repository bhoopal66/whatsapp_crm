import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import {
  appendInsertedMessage,
  pageWithUnsettled,
  patchMessage,
  sentRowId,
} from './optimistic';
import { mergeLatestMessages } from './pagination';

const ME = 'me';
const T = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;

function customer(id: string, n: number, text = 'hello'): Message {
  return {
    id,
    conversation_id: 'c1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: text,
    status: 'delivered',
    created_at: T(n),
  };
}
function mine(id: string, n: number, text = 'hi'): Message {
  return {
    ...customer(id, n, text),
    sender_type: 'agent',
    sender_id: ME,
    status: 'sent',
  };
}
function temp(id: string, n: number, extra: Partial<Message> = {}): Message {
  return {
    ...customer(`temp-${id}`, n, 'hi'),
    sender_type: 'agent',
    status: 'sending',
    ...extra,
  };
}
const ids = (list: Message[]) => list.map((m) => m.id);

describe('appendInsertedMessage', () => {
  it('leaves every bubble in flight when someone else writes', () => {
    const list = [temp('1', 1), temp('2', 2)];
    expect(
      ids(appendInsertedMessage(list, customer('a', 3, 'hi'), ME))
    ).toEqual(['temp-1', 'temp-2', 'a']);
    const colleague = { ...mine('b', 3), sender_id: 'other' };
    expect(ids(appendInsertedMessage(list, colleague, ME))).toHaveLength(3);
    const bot = { ...mine('b', 3), sender_type: 'bot' as const };
    expect(ids(appendInsertedMessage(list, bot, ME))).toHaveLength(3);
  });

  it('replaces at most one bubble, the oldest alike, and keeps the order', () => {
    const list = [customer('a', 0), temp('1', 1), temp('2', 2)];
    const one = appendInsertedMessage(list, mine('r1', 3), ME);
    expect(ids(one)).toEqual(['a', 'r1', 'temp-2']);
    expect(ids(appendInsertedMessage(one, mine('r2', 4), ME))).toEqual([
      'a',
      'r1',
      'r2',
    ]);
  });

  it('does not match another text or type', () => {
    const list = [temp('1', 1)];
    expect(
      ids(appendInsertedMessage(list, mine('r', 2, 'other'), ME))
    ).toContain('temp-1');
    const image = { ...mine('r', 2), content_type: 'image' as const };
    expect(ids(appendInsertedMessage(list, image, ME))).toContain('temp-1');
  });

  it('goes by the row id first, whatever the row says', () => {
    const list = [temp('1', 1), temp('2', 2, { sent_row_id: 'r2' })];
    const row = {
      ...mine('r2', 3, 'rendered differently'),
      sender_id: undefined,
    };
    expect(ids(appendInsertedMessage(list, row, ME))).toEqual(['r2', 'temp-1']);
  });

  it('tells two captionless photos apart, and takes a failed one last', () => {
    const photo = (id: string, url: string) =>
      temp(id, 1, {
        content_type: 'image',
        content_text: undefined,
        media_url: url,
      });
    const row = {
      ...mine('r', 2),
      content_type: 'image' as const,
      content_text: null as unknown as undefined,
      media_url: 'u2',
    };
    expect(
      ids(appendInsertedMessage([photo('1', 'u1'), photo('2', 'u2')], row, ME))
    ).toEqual(['r', 'temp-1']);
    expect(
      ids(
        appendInsertedMessage(
          [temp('1', 1, { status: 'failed' }), temp('2', 2)],
          mine('r', 3),
          ME
        )
      )
    ).toEqual(['r', 'temp-1']);
  });

  it('keeps the list when the row is already here', () => {
    const list = [mine('r', 1), temp('1', 2)];
    expect(appendInsertedMessage(list, mine('r', 1), ME)).toBe(list);
  });
});

describe('two identical texts sent quickly', () => {
  // Every order the INSERTs (i1, i2) and answers (a1, a2) can land in.
  const perms = (xs: string[]): string[][] =>
    xs.length < 2
      ? [xs]
      : xs.flatMap((x) =>
          perms(xs.filter((y) => y !== x)).map((rest) => [x, ...rest])
        );
  for (const order of perms(['i1', 'i2', 'a1', 'a2'])) {
    it(`leaves exactly two bubbles (${order.join(' ')})`, () => {
      let list = [temp('1', 1), temp('2', 2)];
      for (const step of order) {
        const n = step[1];
        list =
          step[0] === 'i'
            ? appendInsertedMessage(list, mine(`r${n}`, 3 + Number(n)), ME)
            : patchMessage(list, `temp-${n}`, {
                status: 'sent',
                sent_row_id: `r${n}`,
              });
        // One only while the second send overtakes the first entirely:
        // its row took the first's bubble, until the first's row lands.
        const overtaken = /^i2 (a2|a1 a2)/.test(order.join(' '));
        expect(list.length).toBeLessThanOrEqual(2);
        if (!overtaken) expect(list).toHaveLength(2);
      }
      expect(ids(list).sort()).toEqual(['r1', 'r2']);
    });
  }
});

describe('patchMessage', () => {
  it('hands back the same array when no row matches', () => {
    const list = [customer('a', 1)];
    expect(patchMessage(list, 'elsewhere', { status: 'read' })).toBe(list);
    expect(patchMessage(list, 'a', { status: 'read' })[0].status).toBe('read');
  });
});

describe('a page read beside bubbles', () => {
  const held = [customer('a', 1), temp('1', 5)];

  it('drops the bubble whose row it holds, by text or by id', () => {
    const page = [customer('a', 1), mine('r', 4)];
    expect(ids(mergeLatestMessages(held, page, 50, ME).messages)).toEqual([
      'a',
      'r',
    ]);
    const named = [customer('a', 1), temp('1', 5, { sent_row_id: 'r' })];
    expect(ids(mergeLatestMessages(named, page, 50, null).messages)).toEqual([
      'a',
      'r',
    ]);
  });

  it('one row settles one bubble', () => {
    const two = [...held, temp('2', 6)];
    const page = [customer('a', 1), mine('r', 4)];
    expect(ids(mergeLatestMessages(two, page, 50, ME).messages)).toEqual([
      'a',
      'r',
      'temp-2',
    ]);
  });

  it('never lets an old identical text settle a new bubble', () => {
    const page = [mine('old', 0), customer('a', 1)];
    expect(ids(mergeLatestMessages(held, page, 50, ME).messages)).toContain(
      'temp-1'
    );
    expect(ids(pageWithUnsettled([temp('1', 5)], page, ME))).toEqual([
      'old',
      'a',
      'temp-1',
    ]);
  });

  it('keeps a sent bubble until its row is here, and a gap keeps bubbles', () => {
    const sent = [
      customer('a', 1),
      temp('1', 5, { status: 'sent', sent_row_id: 'r' }),
    ];
    expect(
      ids(mergeLatestMessages(sent, [customer('a', 1)], 50, ME).messages)
    ).toEqual(['a', 'temp-1']);
    const gap = mergeLatestMessages(
      held,
      [customer('x', 10), customer('y', 11)],
      2,
      ME
    );
    expect(gap.gap).toBe(true);
    expect(ids(gap.messages)).toEqual(['x', 'y', 'temp-1']);
  });
});

describe('sentRowId', () => {
  it('reads the route answer', () => {
    expect(sentRowId({ success: true, message_id: 'r' })).toBe('r');
    expect(sentRowId(null)).toBeUndefined();
    expect(sentRowId({ message_id: 7 })).toBeUndefined();
  });
});
