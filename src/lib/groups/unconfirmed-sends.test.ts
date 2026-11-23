import { describe, expect, it } from 'vitest';

import {
  arrivedUnconfirmed,
  groupSendAnswerKind,
  unconfirmedSends,
  type UnconfirmedSend,
} from './unconfirmed-sends';

describe('groupSendAnswerKind', () => {
  it.each([
    [400, 'invalid_body'],
    [403, 'not_group_admin'],
    [404, 'group_not_found'],
    [429, 'rate_limited'],
    [413, undefined],
    [503, 'unavailable'],
    [503, 'channel_disconnected'],
    [500, 'channel_credentials_unreadable'],
  ])('%i %s certainly did not go out', (status, code) => {
    expect(groupSendAnswerKind(status, code)).toBe('refused');
  });

  it.each([
    [502, 'send_unconfirmed'],
    [502, 'gateway_unavailable'],
    [502, 'unknown'],
    [500, undefined],
    [504, undefined],
    [524, undefined],
    [408, undefined],
  ])('%i %s may have gone out', (status, code) => {
    expect(groupSendAnswerKind(status, code)).toBe('maybe');
  });
});

const at = (s: number) =>
  new Date(Date.UTC(2026, 10, 23, 9, 0, s)).toISOString();

const message = (extra: Partial<UnconfirmedSend['message']> = {}) => ({
  id: 'm1',
  direction: 'out' as const,
  sender_wa_id: null,
  sender_name: null,
  sender_user_id: null,
  type: 'text',
  body: 'hello',
  status: 'sent' as const,
  created_at: at(5),
  ...extra,
});

const send = (extra: Partial<UnconfirmedSend> = {}): UnconfirmedSend => ({
  groupId: 'g1',
  message: message({ id: 'tmp-1', status: 'pending', sender_user_id: 'me' }),
  knownIds: new Set(['old']),
  ...extra,
});

describe('arrivedUnconfirmed', () => {
  const settled = (
    rows: UnconfirmedSend[],
    messages: UnconfirmedSend['message'][]
  ) => arrivedUnconfirmed(rows, 'g1', messages, 'me');

  it("is settled by the echo, which is nobody's, and by one's own row", () => {
    expect(settled([send()], [message()])).toHaveLength(1);
    expect(settled([send()], [message({ sender_user_id: 'me' })])).toHaveLength(
      1
    );
  });

  it('counts an echo stamped a little before this clock', () => {
    expect(settled([send()], [message({ created_at: at(0) })])).toHaveLength(1);
  });

  it.each([
    ['another person’s', { sender_user_id: 'someone' }],
    ['a customer’s', { direction: 'in' as const }],
    ['other words', { body: 'hello!' }],
    ['another kind', { type: 'image' }],
    ['one that was already there', { id: 'old' }],
    ['a send still on its way', { status: 'pending' as const }],
    ['an old one', { created_at: '2026-11-23T08:00:00.000Z' }],
  ])('is not settled by %s', (_what, extra) => {
    expect(settled([send()], [message(extra)])).toEqual([]);
  });

  it('settles one send per message, and only this group’s', () => {
    const a = send();
    const b = send({ message: { ...a.message, id: 'tmp-2' } });
    expect(settled([a, b], [message()])).toEqual([a]);
    expect(settled([send({ groupId: 'g2' })], [message()])).toEqual([]);
  });
});

describe('the store', () => {
  it('keeps a send for its own login only', () => {
    unconfirmedSends.claim('me');
    expect(unconfirmedSends.add('me', send())).toBe(true);
    expect(unconfirmedSends.add('you', send())).toBe(false);
    expect(unconfirmedSends.get()).toHaveLength(1);
    unconfirmedSends.claim('you');
    expect(unconfirmedSends.get()).toEqual([]);
  });
});
