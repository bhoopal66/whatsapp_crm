import { describe, expect, it } from 'vitest';

import {
  formatMention,
  insertMentionAt,
  mentionQueryAt,
  mentionSegments,
  parseMentions,
} from '../mentions';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// '<@' + 36-char uuid + '>'
const TOKEN = 39;

describe('formatMention / parseMentions (ported from 014b)', () => {
  it('round-trips and lower-cases', () => {
    expect(
      parseMentions([U1, U2].map(formatMention).join(' ')).userIds
    ).toEqual([U1, U2]);
    expect(
      parseMentions(`<@${U2.toUpperCase()}> ${formatMention(U2)}`).userIds
    ).toEqual([U2]);
    expect(() => formatMention('not-a-uuid')).toThrow(TypeError);
    expect(parseMentions('<@not-a-uuid> plain')).toEqual({
      userIds: [],
      broadcast: [],
    });
  });

  it('matches what chat_post_message records', () => {
    expect(
      parseMentions(
        `@here first <@${U1}>, again <@${U1}> and <@${U2.toUpperCase()}> (@CHANNEL)`
      )
    ).toEqual({
      userIds: [U1, U2],
      broadcast: ['here', 'channel'],
    });
    expect(
      parseMentions(`mail@channel.com x_@here @heres @channelx <@${U1}`)
    ).toEqual({ userIds: [], broadcast: [] });
    expect(parseMentions(`مرحبا@here <@${U1}>`)).toEqual({
      userIds: [U1],
      broadcast: [],
    });
  });
});

describe('mentionSegments', () => {
  it('splits text, user chips (unknown → null) and broadcast chips', () => {
    expect(
      mentionSegments(`hi <@${U1}>, see @here and <@${U2}>!`, [
        { userId: U1, fullName: 'Asha' },
      ])
    ).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', userId: U1, name: 'Asha' },
      { type: 'text', text: ', see ' },
      { type: 'broadcast', kind: 'here' },
      { type: 'text', text: ' and ' },
      { type: 'mention', userId: U2, name: null },
      { type: 'text', text: '!' },
    ]);
  });
  it('a body that is only tokens, and plain text', () => {
    expect(mentionSegments('@Channel', [])).toEqual([
      { type: 'broadcast', kind: 'channel' },
    ]);
    expect(mentionSegments('mail@here.com', [])).toEqual([
      { type: 'text', text: 'mail@here.com' },
    ]);
    expect(mentionSegments('', [])).toEqual([]);
  });
});

describe('composer helpers', () => {
  it('finds the @query before the caret', () => {
    expect(mentionQueryAt('hello @as', 9)).toEqual({ start: 6, query: 'as' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail@as', 7)).toBeNull();
    expect(mentionQueryAt('hello @as there', 15)).toBeNull();
  });

  it('replaces the @query with a token and moves the caret past it', () => {
    expect(insertMentionAt('hello @as', 9, { userId: U1 })).toEqual({
      text: `hello <@${U1}> `,
      caret: 6 + TOKEN + 1,
    });
    expect(insertMentionAt('hi @a there', 5, { userId: U1 })).toEqual({
      text: `hi <@${U1}> there`,
      caret: 3 + TOKEN + 1,
    });
  });

  it('inserts at the caret with a separating space when nothing is typed', () => {
    expect(insertMentionAt('hi', 2, { userId: U1 })).toEqual({
      text: `hi <@${U1}> `,
      caret: 2 + 1 + TOKEN + 1,
    });
    expect(insertMentionAt('', 0, { userId: U1 }).text).toBe(`<@${U1}> `);
  });
});
