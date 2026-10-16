import { describe, expect, it } from 'vitest';

import {
  nameSearchPattern,
  normalisePhoneList,
  parseCreate,
  parsePatch,
} from './requests';

const CH = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';

const code400 = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { status?: number; code?: string }).status === 400
      ? (err as { code: string }).code
      : 'other';
  }
  return 'none';
};

describe('normalisePhoneList', () => {
  it('dedupes by wa_id and reports bad entries without throwing', () => {
    expect(
      normalisePhoneList([
        '+971 50 123 4567',
        '00971501234567',
        'abc',
        42,
        '971501234568',
      ])
    ).toEqual({
      waIds: ['971501234567', '971501234568'],
      invalid: ['abc', '42'],
    });
  });
});

describe('parsePatch', () => {
  it('trims the name and keeps known settings', () => {
    expect(
      parsePatch({ name: '  New ', settings: { send_messages: 'admins' } })
    ).toEqual({ name: 'New', settings: { send_messages: 'admins' } });
  });

  it.each([
    [null],
    [{}],
    [{ name: '' }],
    [{ name: 'x'.repeat(101) }],
    [{ description: 5 }],
    [{ settings: { send_messages: 'everyone' } }],
    [{ settings: { colour: 'admins' } }],
  ])('refuses %j', (body) => {
    expect(code400(() => parsePatch(body))).toBe('invalid_body');
  });
});

describe('parseCreate', () => {
  it('normalises the whole body', () => {
    const out = parseCreate({
      channelId: CH.toUpperCase(),
      name: ' Team ',
      description: ' Hello ',
      participants: ['+971501234567', 'nope'],
      contactIds: [C1, C1],
      settings: { add_participants: 'admins' },
      managerIds: [C1],
    });
    expect(out).toEqual({
      channelId: CH,
      name: 'Team',
      description: 'Hello',
      participants: { waIds: ['971501234567'], invalid: ['nope'] },
      contactIds: [C1],
      settings: { add_participants: 'admins' },
      managerIds: [C1],
    });
  });

  it('accepts contacts alone, and only-invalid phones (reported later)', () => {
    expect(
      parseCreate({ channelId: CH, name: 'A', contactIds: [C1] }).contactIds
    ).toEqual([C1]);
    expect(
      parseCreate({ channelId: CH, name: 'A', participants: ['x'] })
        .participants
    ).toEqual({ waIds: [], invalid: ['x'] });
  });

  it.each([
    [{ name: 'A', participants: ['971501234567'] }],
    [{ channelId: CH, participants: ['971501234567'] }],
    [{ channelId: CH, name: 'A' }],
    [{ channelId: CH, name: 'A', participants: 'x' }],
    [{ channelId: CH, name: 'A', contactIds: ['not-a-uuid'] }],
    [{ channelId: CH, name: 'A', contactIds: [C1], managerIds: [1] }],
    [{ channelId: CH, name: 'A', contactIds: [C1], settings: { x: 'a' } }],
    [
      {
        channelId: CH,
        name: 'A',
        participants: Array(257).fill('971501234567'),
      },
    ],
  ])('refuses %j', (body) => {
    expect(code400(() => parseCreate(body))).toBe('invalid_body');
  });
});

describe('nameSearchPattern', () => {
  it('escapes LIKE metacharacters and blanks to null', () => {
    expect(nameSearchPattern('  ')).toBeNull();
    expect(nameSearchPattern(null)).toBeNull();
    expect(nameSearchPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(nameSearchPattern('a*b')).toBe('%a_b%');
  });
});
