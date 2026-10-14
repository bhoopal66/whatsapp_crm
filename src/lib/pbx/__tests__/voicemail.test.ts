import { describe, expect, it, vi } from 'vitest';
import {
  isVoicemailId,
  markedRead,
  removed,
  voicemailAudioPath,
  voicemailCaller,
  voicemailDuration,
  voicemailTime,
  type VoicemailItem,
  type VoicemailListResponse,
} from '../voicemail';
import {
  VOICEMAIL_PAGE_SIZE,
  findOwnVoicemail,
  voicemailAudioType,
  voicemailContacts,
  voicemailItems,
} from '../voicemail-server';
import type { VoicemailMessage } from '../yeastar';
import { createFakeDb } from './fake-db';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const msg = (over: Partial<VoicemailMessage> = {}): VoicemailMessage => ({
  msgId: '1713840555-00000623',
  fileName: 'msg0000.wav',
  read: false,
  callerName: '',
  callerNumber: '0501234567',
  time: '2026/10/14 09:30:00',
  durationSeconds: 18,
  ...over,
});

const item = (over: Partial<VoicemailItem> = {}): VoicemailItem => ({
  id: 'm-1',
  callerNumber: '0501234567',
  callerName: '',
  at: '2026-10-14T05:30:00.000Z',
  durationSeconds: 18,
  read: false,
  contactId: null,
  ...over,
});

describe('voicemail ids', () => {
  it('takes the PBX’s msg_id shape only', () => {
    expect(isVoicemailId('1713840555-00000623')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(65), '%2e'])
      expect(isVoicemailId(bad)).toBe(false);
  });

  it('builds the audio route, escaped', () => {
    expect(voicemailAudioPath('1713840555-00000623')).toBe(
      '/api/pbx/voicemail/1713840555-00000623/audio'
    );
    expect(voicemailAudioPath('a b')).toBe('/api/pbx/voicemail/a%20b/audio');
  });
});

describe('voicemailCaller', () => {
  it('shows the name over the number when it says more', () => {
    expect(
      voicemailCaller({ callerName: 'John', callerNumber: '0501234567' })
    ).toEqual({ primary: 'John', secondary: '0501234567' });
  });
  it('shows the number alone when the name is it or empty', () => {
    expect(voicemailCaller({ callerName: '201', callerNumber: '201' })).toEqual(
      { primary: '201', secondary: null }
    );
    expect(voicemailCaller({ callerName: ' ', callerNumber: '201' })).toEqual({
      primary: '201',
      secondary: null,
    });
  });
  it('is null for a withheld caller', () => {
    expect(voicemailCaller({ callerName: '', callerNumber: '' })).toBeNull();
  });
});

describe('voicemailDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(voicemailDuration(0)).toBe('0:00');
    expect(voicemailDuration(42)).toBe('0:42');
    expect(voicemailDuration(725)).toBe('12:05');
    expect(voicemailDuration(3729)).toBe('1:02:09');
  });
  it('treats junk as zero', () => {
    expect(voicemailDuration(-3)).toBe('0:00');
    expect(voicemailDuration(Number.NaN)).toBe('0:00');
  });
});

describe('voicemailTime', () => {
  it('formats in the given zone and is empty when unknown', () => {
    expect(voicemailTime('2026-10-14T05:30:00.000Z', 'en-GB', 'UTC')).toBe(
      '14 Oct 2026, 05:30'
    );
    expect(voicemailTime(null, 'en')).toBe('');
    expect(voicemailTime('nonsense', 'en')).toBe('');
  });
});

describe('list updates', () => {
  const list: VoicemailListResponse = {
    messages: [item({ id: 'a' }), item({ id: 'b', read: true })],
    unread: 1,
    total: 7,
  };

  it('marks one read once', () => {
    const next = markedRead(list, 'a');
    expect(next.messages.map((m) => m.read)).toEqual([true, true]);
    expect(next.unread).toBe(0);
    expect(markedRead(next, 'a')).toBe(next);
    expect(markedRead(list, 'b')).toBe(list);
    expect(markedRead(list, 'zz')).toBe(list);
  });

  it('removes one, counting unread and total', () => {
    expect(removed(list, 'a')).toEqual({
      messages: [list.messages[1]],
      unread: 0,
      total: 6,
    });
    expect(removed(list, 'b')).toMatchObject({ unread: 1, total: 6 });
    expect(removed(list, 'zz')).toBe(list);
  });
});

describe('findOwnVoicemail', () => {
  const pages = (boxes: VoicemailMessage[][], total: number) =>
    vi.fn(async ({ page = 1 }: { page?: number }) => ({
      total,
      items: boxes[page - 1] ?? [],
    }));

  it('finds an id on the caller’s own box only', async () => {
    const listVoicemail = pages([[msg({ msgId: 'x' })]], 1);
    expect(await findOwnVoicemail({ listVoicemail }, '201', 'x')).toEqual(
      msg({ msgId: 'x' })
    );
    expect(listVoicemail).toHaveBeenCalledWith({
      number: '201',
      page: 1,
      pageSize: VOICEMAIL_PAGE_SIZE,
    });
    expect(await findOwnVoicemail({ listVoicemail }, '201', 'y')).toBeNull();
  });

  it('pages on until the box is read through', async () => {
    const first = Array.from({ length: VOICEMAIL_PAGE_SIZE }, (_, i) =>
      msg({ msgId: `p1-${i}` })
    );
    const listVoicemail = pages([first, [msg({ msgId: 'late' })]], 101);
    expect(
      (await findOwnVoicemail({ listVoicemail }, '201', 'late'))?.msgId
    ).toBe('late');
    expect(listVoicemail).toHaveBeenCalledTimes(2);

    listVoicemail.mockClear();
    expect(await findOwnVoicemail({ listVoicemail }, '201', 'nope')).toBeNull();
    expect(listVoicemail).toHaveBeenCalledTimes(2);
  });

  it('stops on an empty page whatever the total says', async () => {
    const listVoicemail = pages([[]], 500);
    expect(await findOwnVoicemail({ listVoicemail }, '201', 'x')).toBeNull();
    expect(listVoicemail).toHaveBeenCalledTimes(1);
  });
});

describe('voicemailContacts', () => {
  it('matches outside numbers in the caller’s account by digits', async () => {
    const fake = createFakeDb({
      contacts: [
        { id: 'c-1', account_id: A, phone_normalized: '971501234567' },
        { id: 'c-other', account_id: B, phone_normalized: '971559999999' },
      ],
    });
    const found = await voicemailContacts(fake.db, A, [
      '0501234567',
      '+971 50 123 4567',
      '0559999999',
      '201',
      '',
    ]);
    expect(Object.fromEntries(found)).toEqual({
      '0501234567': 'c-1',
      '+971 50 123 4567': 'c-1',
    });
  });

  it('reads nothing when there is nothing to match', async () => {
    const fake = createFakeDb({ contacts: [] });
    expect((await voicemailContacts(fake.db, A, ['201', ''])).size).toBe(0);
    expect(fake.log).toEqual([]);
  });

  it('throws a read error for the route', async () => {
    const fake = createFakeDb({ contacts: [] });
    fake.fail('contacts', 'select', { message: 'boom' });
    await expect(voicemailContacts(fake.db, A, ['0501234567'])).rejects.toThrow(
      'contacts read failed: boom'
    );
  });
});

describe('voicemailItems', () => {
  it('maps to the route’s shape, newest first, unknown times last', () => {
    const out = voicemailItems(
      [
        msg({ msgId: 'old', time: '2026/10/13 09:00:00', read: true }),
        msg({ msgId: 'bad', time: 'whenever' }),
        msg({
          msgId: 'new',
          time: '2026/10/14 09:30:00',
          callerName: 'John',
        }),
      ],
      new Map([['0501234567', 'c-1']])
    );
    expect(out.map((m) => m.id)).toEqual(['new', 'old', 'bad']);
    expect(out[0]).toEqual({
      id: 'new',
      callerNumber: '0501234567',
      callerName: 'John',
      // Wall-clock Dubai time (the PBX default zone), UTC+4.
      at: '2026-10-14T05:30:00.000Z',
      durationSeconds: 18,
      read: false,
      contactId: 'c-1',
    });
    expect(out[2].at).toBeNull();
  });
});

describe('voicemailAudioType', () => {
  it('trusts an audio type from the PBX', () => {
    expect(voicemailAudioType('x.wav', 'audio/mpeg; charset=x')).toBe(
      'audio/mpeg'
    );
  });
  it('else goes by the file name, defaulting to wav', () => {
    expect(voicemailAudioType('msg.mp3', 'application/octet-stream')).toBe(
      'audio/mpeg'
    );
    expect(voicemailAudioType('msg.WAV', null)).toBe('audio/wav');
    expect(voicemailAudioType('msg.gsm', null)).toBe('audio/x-gsm');
    expect(voicemailAudioType('msg', null)).toBe('audio/wav');
  });
});
