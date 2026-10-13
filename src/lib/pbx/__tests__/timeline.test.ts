import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '../../../../messages/en.json';
import {
  callHeading,
  callsSidebar,
  entryHeading,
  filterTimeline,
  groupByDay,
  maskPhone,
  mergeTimeline,
  recordingView,
  refusalView,
  missedTaskFor,
  monthSummaryParts,
  openMissedTasks,
  openTaskLine,
  playerClock,
  presenceDotState,
  recentPeople,
  splitCallLog,
  startOfDay,
  takeComposerPrefill,
  taskStrip,
  teamOnCustomer,
  type Part,
  type TimelineCall,
} from '../timeline';

const TZ = 'Asia/Dubai';
const t = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'CustomerTimeline',
});
const say = (p: Part) =>
  typeof p === 'string' ? p : t(p.key as never, p.values as never);
const line = (h: { label: Part; details: Part[] }) =>
  [say(h.label), ...h.details.map(say)].join(' · ');

// 2026-10-12 12:00 in Dubai (UTC+4).
const NOW = Date.parse('2026-10-12T08:00:00Z');

const call = (over: Partial<TimelineCall> = {}): TimelineCall => ({
  id: 'c1',
  direction: 'inbound',
  status: 'answered',
  startedAt: '2026-10-12T06:53:00Z',
  answeredAt: '2026-10-12T06:53:10Z',
  ringSeconds: 10,
  talkSeconds: 378,
  userId: 'u-sara',
  userName: 'Sara',
  disposition: 'docs_requested',
  notes: 'Wants the salary letter checklist',
  recordingState: 'fetched',
  ...over,
});
const missed = call({
  id: 'c2',
  status: 'no_answer',
  startedAt: '2026-10-12T07:40:00Z',
  answeredAt: null,
  ringSeconds: 24,
  talkSeconds: 0,
  disposition: null,
});

const sources = {
  calls: [call(), missed],
  messages: [
    {
      id: 'm1',
      senderType: 'customer',
      senderId: null,
      senderName: null,
      text: 'Sent the docs',
      contentType: 'text',
      createdAt: '2026-10-12T06:52:00Z',
    },
  ],
  notes: [
    {
      id: 'n1',
      text: 'VIP',
      authorName: 'Faisal',
      createdAt: '2026-10-11T05:00:00Z',
    },
  ],
  internal: [
    {
      id: 'i1',
      channelId: 'ch1',
      channelName: 'mashreq-desk',
      authorName: 'Faisal',
      body: 'Can someone call Khalid?',
      createdAt: '2026-10-12T06:31:00Z',
    },
  ],
};

describe('mergeTimeline / filterTimeline', () => {
  it('merges the four sources newest first and drops undated rows', () => {
    const entries = mergeTimeline({
      ...sources,
      notes: [
        ...sources.notes,
        { ...sources.notes[0], id: 'n2', createdAt: 'x' },
      ],
    });
    expect(entries.map((e) => e.id)).toEqual(['c2', 'c1', 'm1', 'i1', 'n1']);
  });

  it('keeps each filter to its own kinds', () => {
    const entries = mergeTimeline(sources);
    const kinds = (f: Parameters<typeof filterTimeline>[1]) =>
      filterTimeline(entries, f).map((e) => e.kind);
    expect(kinds('calls')).toEqual(['call', 'call']);
    expect(kinds('whatsapp')).toEqual(['whatsapp']);
    expect(kinds('notes')).toEqual(['internal', 'note']);
    expect(kinds('all')).toHaveLength(5);
  });
});

describe('groupByDay', () => {
  it('labels today, yesterday and older days in the zone', () => {
    const groups = groupByDay(
      [
        { at: '2026-10-12T07:00:00Z' },
        // 21:30 UTC on the 11th is already the 12th in Dubai.
        { at: '2026-10-11T21:30:00Z' },
        { at: '2026-10-11T05:00:00Z' },
        { at: '2026-10-01T05:00:00Z' },
      ],
      (x) => x.at,
      NOW,
      TZ
    );
    expect(groups.map((g) => [g.label, g.key, g.items.length])).toEqual([
      ['today', '2026-10-12', 2],
      ['yesterday', '2026-10-11', 1],
      ['date', '2026-10-01', 1],
    ]);
  });
});

describe('headings', () => {
  it('words a missed call with who it rang and for how long', () => {
    const h = callHeading(missed, {
      timeZone: TZ,
      locale: 'en',
      rang: ['Sara', 'Faisal', 'Sara'],
    });
    expect(line(h)).toBe(
      'Missed call · incoming · 11:40 · rang Sara and Faisal for 24 s'
    );
  });

  it('words an answered call with the duration and outcome', () => {
    expect(line(callHeading(call(), { timeZone: TZ, locale: 'en' }))).toBe(
      'Incoming call · answered by Sara · 10:53 · 6 min 18 s · Docs requested'
    );
    expect(
      line(
        callHeading(
          call({
            direction: 'outbound',
            status: 'busy',
            answeredAt: null,
            disposition: null,
          }),
          { timeZone: TZ, locale: 'en' }
        )
      )
    ).toBe('Outgoing call · Sara · 10:53 · busy');
  });

  it('words WhatsApp, internal and note entries', () => {
    const [, , wa, internal, note] = mergeTimeline(sources);
    const ctx = { timeZone: TZ, locale: 'en', contactName: 'Khalid' };
    expect(line(entryHeading(wa, ctx))).toBe('WhatsApp · 10:52 · from Khalid');
    expect(line(entryHeading(internal, ctx))).toBe(
      '#mashreq-desk · 10:31 · Faisal · internal'
    );
    expect(line(entryHeading(note, ctx))).toBe('Note · 09:00 · Faisal');
  });
});

describe('tasks', () => {
  const task = {
    id: 't1',
    kind: 'missed_call',
    title: 'Call back Khalid',
    status: 'open',
    due_at: '2026-10-12T08:10:00Z',
    assigned_to: 'u-sara',
    source_ref: 'call:c2',
    meta: { call_id: 'c2' },
  };

  it('finds the missed call task and words its strip', () => {
    expect(missedTaskFor('c2', [task])).toBe(task);
    expect(missedTaskFor('c1', [task])).toBeNull();
    expect(say(taskStrip(task, 'Sara', TZ))).toBe(
      'Task for Sara: call back by 12:10'
    );
    expect(say(taskStrip({ due_at: null }, null, TZ))).toBe('Task: call back');
    expect(say(openTaskLine(task, TZ))).toBe('Call back Khalid — due 12:10');
  });

  it('counts my open missed-call tasks only', () => {
    expect(
      openMissedTasks(
        [
          task,
          { ...task, status: 'done' },
          { ...task, assigned_to: 'u-other' },
          { ...task, kind: 'manual' },
        ],
        'u-sara'
      )
    ).toBe(1);
    expect(openMissedTasks([task], null)).toBe(0);
  });
});

describe('right column', () => {
  it('words the month summary', () => {
    const p = monthSummaryParts({
      total: 5,
      answered: 3,
      missed: 2,
      talkSeconds: 1020,
    });
    expect(say(p.counts)).toBe('5 calls · 3 answered · 2 missed');
    expect(say(p.talk)).toBe('Talk time 17 min');
    expect(
      say(
        monthSummaryParts({ total: 1, answered: 1, missed: 0, talkSeconds: 0 })
          .counts
      )
    ).toBe('1 call · 1 answered · 0 missed');
  });

  it('dots presence from the PBX first, then the app', () => {
    expect(presenceDotState('available', 'offline')).toEqual({
      tone: 'green',
      key: 'presence.available',
    });
    expect(presenceDotState('on_call', 'online').tone).toBe('red');
    expect(presenceDotState('off_work', 'online')).toEqual({
      tone: 'ring',
      key: 'presence.offWork',
    });
    expect(presenceDotState(undefined, 'online').tone).toBe('green');
    expect(presenceDotState(undefined, undefined).tone).toBe('ring');
  });

  it('lists the owner, the assignee, then recent people once each', () => {
    const recent = recentPeople(mergeTimeline(sources));
    expect(recent).toEqual(['u-sara']);
    expect(
      teamOnCustomer({
        ownerId: 'u-rm',
        assigneeId: 'u-sara',
        recent: [...recent, 'u-rm', 'u-x'],
      })
    ).toEqual([
      { userId: 'u-rm', role: 'ownerRm' },
      { userId: 'u-sara', role: 'assignee' },
      { userId: 'u-x', role: 'recent' },
    ]);
  });

  it('masks a phone like chat_mask_phone', () => {
    expect(maskPhone('+971 50 123 4512')).toBe('+971 XXXXXXX12');
    expect(maskPhone('+44 7700 900123')).toBe('+44 XXXXXXXX23');
    expect(maskPhone('')).toBe('');
  });

  it('formats the player clock', () => {
    expect(playerClock(378)).toBe('6:18');
    expect(playerClock(null)).toBe('0:00');
  });
});

describe('calls page and sidebar', () => {
  it('splits the log into today and older in the zone', () => {
    const s = splitCallLog(
      [
        { startedAt: '2026-10-12T07:00:00Z' },
        { startedAt: '2026-10-11T12:00:00Z' },
      ],
      NOW,
      TZ
    );
    expect([s.today.length, s.older.length]).toEqual([1, 1]);
    expect(startOfDay(NOW, TZ)).toBe('2026-10-11T20:00:00.000Z');
  });

  it('shows CALLS to staff with an extension or a PBX in the workspace', () => {
    const me = {
      extension: '1012',
      softphoneEnabled: true,
      softphoneAvailable: true,
    };
    const base = {
      isBankGuest: false,
      workspaceHasPbx: false,
      softphone: 'ready' as const,
    };
    expect(callsSidebar({ ...base, me })).toEqual({
      visible: true,
      line: { kind: 'softphone', extension: '1012' },
    });
    expect(
      callsSidebar({
        ...base,
        me: { ...me, softphoneAvailable: false },
        workspaceHasPbx: true,
      }).line
    ).toEqual({ kind: 'desk', extension: '1012' });
    expect(
      callsSidebar({ ...base, me: { extension: null }, workspaceHasPbx: true })
    ).toEqual({ visible: true, line: null });
    expect(callsSidebar({ ...base, me: { extension: null } }).visible).toBe(
      false
    );
    expect(
      callsSidebar({ ...base, isBankGuest: true, me, workspaceHasPbx: true })
        .visible
    ).toBe(false);
  });

  it('says the softphone is ready only once it has registered', () => {
    const me = {
      extension: '1012',
      softphoneEnabled: true,
      softphoneAvailable: true,
    };
    const kind = (softphone: Parameters<typeof callsSidebar>[0]['softphone']) =>
      callsSidebar({ isBankGuest: false, me, workspaceHasPbx: true, softphone })
        .line?.kind;
    expect(kind('ready')).toBe('softphone');
    expect(kind('loading')).toBe('softphoneConnecting');
    expect(kind('connecting')).toBe('softphoneConnecting');
    expect(kind('reconnecting')).toBe('softphoneConnecting');
    expect(kind('error')).toBe('softphoneError');
    expect(kind('off')).toBe('desk');
  });

  it('hands a composer prefill over once', () => {
    const store = new Map([
      ['wacrm:composer-prefill:cv1', 'Sorry we missed your call'],
    ]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    expect(takeComposerPrefill(storage, 'cv1')).toBe(
      'Sorry we missed your call'
    );
    expect(takeComposerPrefill(storage, 'cv1')).toBeNull();
    expect(takeComposerPrefill(null, 'cv1')).toBeNull();
  });
});

describe('recordingView', () => {
  it('maps the call state, and a fetched call whose audio retention deleted', () => {
    expect(recordingView({ recordingState: 'fetched' })).toBe('player');
    expect(
      recordingView({ recordingState: 'fetched', recordingDeleted: true })
    ).toBe('expired');
    expect(recordingView({ recordingState: 'erased' })).toBe('erased');
    expect(recordingView({ recordingState: 'not_stored' })).toBe('notStored');
    expect(recordingView({ recordingState: 'none' })).toBeUndefined();
    expect(recordingView({ recordingState: 'failed' })).toBeUndefined();
  });
});

describe('refusalView', () => {
  it('shows what the server says happened to the audio', () => {
    expect(refusalView('expired')).toBe('expired');
    expect(refusalView('erased')).toBe('erased');
    expect(refusalView('not_stored')).toBe('notStored');
    expect(refusalView('held')).toBe('held');
    expect(refusalView(undefined)).toBe('held');
    expect(refusalView('constructor')).toBe('held');
  });
});
