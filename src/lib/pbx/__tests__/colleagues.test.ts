import { describe, expect, it } from 'vitest';

import {
  colleagueRows,
  filterColleagues,
  phoneDot,
  type ExtensionRow,
} from '../colleagues';
import type { UserPresence } from '../presence';

const ext = (
  extension: string,
  user_id: string | null,
  extra: Partial<ExtensionRow> = {}
): ExtensionRow => ({
  extension,
  user_id,
  presence_monitor: true,
  registration_state: 'registered',
  ...extra,
});

const at = '2026-10-14T09:00:00Z';
const live = (
  extension: string,
  state: UserPresence['state']
): UserPresence => ({ extension, state, updatedAt: at });

const names = { u1: 'Zara Khan', u2: 'adam Smith', u3: 'Omar', ME: 'Me' };

describe('colleagueRows', () => {
  it('lists people by name, then extensions with no name by number', () => {
    const rows = colleagueRows({
      extensions: [
        ext('1010', null),
        ext('1002', 'u1'),
        ext('109', null),
        ext('1003', 'u2'),
        ext('1004', 'unknown-user'),
        ext('1001', 'u3'),
      ],
      names,
      phone: {},
      myUserId: null,
    });
    expect(rows.map((r) => [r.name, r.extension])).toEqual([
      ['adam Smith', '1003'],
      ['Omar', '1001'],
      ['Zara Khan', '1002'],
      // Numbers sort as numbers, and a person with no name here
      // (another workspace's profile) is listed by number.
      [null, '109'],
      [null, '1004'],
      [null, '1010'],
    ]);
  });

  it("shows the phone's state for a monitored extension of a person", () => {
    const rows = colleagueRows({
      extensions: [
        ext('1001', 'u1'),
        ext('1002', 'u2'),
        ext('1003', 'u3', { presence_monitor: false }),
        ext('1004', null),
      ],
      names,
      phone: { u1: live('1001', 'on_call'), u3: live('1003', 'dnd') },
      myUserId: null,
    });
    const by = Object.fromEntries(rows.map((r) => [r.extension, r.presence]));
    expect(by).toEqual({
      '1001': 'on_call',
      // Monitored, no row yet: Yeastar's default status.
      '1002': 'online',
      // Not monitored, or no person: unknown.
      '1003': null,
      '1004': null,
    });
  });

  it('reads the phone row by lower-cased user id', () => {
    const [row] = colleagueRows({
      extensions: [ext('1001', 'U1-ABC')],
      names: { 'U1-ABC': 'Upper' },
      phone: { 'u1-abc': live('1001', 'away') },
      myUserId: null,
    });
    expect(row.presence).toBe('away');
  });

  it("ignores a person's phone row for another extension of theirs", () => {
    const [row] = colleagueRows({
      extensions: [ext('1001', 'u1')],
      names,
      phone: { u1: live('2001', 'on_call') },
      myUserId: null,
    });
    expect(row.presence).toBeNull();
  });

  it('flags an extension no phone is signed in to', () => {
    const rows = colleagueRows({
      extensions: [
        ext('1', 'u1'),
        ext('2', 'u2', { registration_state: 'unregistered' }),
        ext('3', 'u3', { registration_state: null }),
      ],
      names,
      phone: {},
      myUserId: null,
    });
    expect(rows.map((r) => [r.extension, r.unregistered])).toEqual([
      ['2', true],
      ['3', false],
      ['1', false],
    ]);
  });

  it("marks the caller's own row", () => {
    const rows = colleagueRows({
      extensions: [ext('1001', 'me'), ext('1002', 'u1'), ext('1003', null)],
      names: { ...names, me: 'Me' },
      phone: {},
      myUserId: 'ME',
      myExtension: '1001',
    });
    expect(rows.filter((r) => r.mine).map((r) => r.extension)).toEqual([
      '1001',
    ]);
    const byExtension = colleagueRows({
      extensions: [ext('1003', null)],
      names,
      phone: {},
      myUserId: 'me',
      myExtension: '1003',
    });
    expect(byExtension[0].mine).toBe(true);
  });
});

describe('phoneDot', () => {
  it("is the phone's view, available being a green dot", () => {
    expect(phoneDot('available')).toBe('online');
    expect(phoneDot('on_call')).toBe('on_call');
    expect(phoneDot('dnd')).toBe('dnd');
    expect(phoneDot('away')).toBe('away');
    expect(phoneDot('off_work')).toBe('off_work');
  });
});

describe('filterColleagues', () => {
  const rows = colleagueRows({
    extensions: [ext('1001', 'u1'), ext('2002', 'u2'), ext('3003', null)],
    names,
    phone: {},
    myUserId: null,
  });
  const exts = (q: string) => filterColleagues(rows, q).map((r) => r.extension);

  it('matches part of a name in any case, or part of an extension', () => {
    expect(exts('khan')).toEqual(['1001']);
    expect(exts('  ADAM ')).toEqual(['2002']);
    expect(exts('300')).toEqual(['3003']);
    expect(exts('00')).toEqual(['2002', '1001', '3003']);
    expect(exts('nobody')).toEqual([]);
  });

  it('keeps every row, in order, for an empty search', () => {
    expect(exts('')).toEqual(['2002', '1001', '3003']);
    expect(exts('   ')).toEqual(['2002', '1001', '3003']);
  });
});
