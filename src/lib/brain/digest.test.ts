/** 022d digest core (pure): buildDigest over an in-memory DigestSource. */
import { describe, expect, it } from 'vitest';

import {
  buildDigest,
  endOfDubaiDay,
  ar,
  isPromise,
  snippet,
  type Digest,
  type DigestCase,
  type DigestMessage,
  type DigestSource,
  type DigestTask,
} from './digest';

const DAY = 86_400_000;
const NOW = new Date('2026-11-11T08:00:00Z');
const ago = (days: number, now = NOW) => new Date(now.getTime() - days * DAY);
const kase = (caseId: string, o: Partial<DigestCase> = {}): DigestCase => ({
  caseId,
  bankCode: 'B1',
  stage: 'Submitted',
  contactId: 'K1',
  lastActivityAt: ago(1),
  snoozedUntil: null,
  outcome: null,
  closedAt: null,
  ...o,
});
const msg = (
  itemId: string,
  caseId: string,
  text: string,
  at: Date,
  contactId = 'K1'
): DigestMessage => ({
  itemId,
  sourceId: itemId,
  caseId,
  contactId,
  text,
  createdBy: 'agentA',
  createdAt: at,
});

function mem(
  cases: DigestCase[],
  messages: DigestMessage[] = [],
  tasks: DigestTask[] = []
): DigestSource {
  return {
    cases: async () => cases,
    messages: async (_a, _w, since) =>
      messages.filter((m) => m.createdAt.getTime() >= since.getTime()),
    closedCases: async (_a, _w, contacts, banks) =>
      cases.filter(
        (c) =>
          c.outcome !== null &&
          (contacts.includes(c.contactId ?? '') ||
            banks.includes(c.bankCode ?? ''))
      ),
    tasksDueBefore: async () => tasks,
  };
}
const build = (source: DigestSource, now = NOW) =>
  buildDigest({ actorId: 'agentA', accountId: 'acc1', now, source });
const sec = (d: Digest, kind: string) =>
  d.sections.find((s) => s.kind === kind)!.items;
const ids = (d: Digest, kind: string) => sec(d, kind).map((i) => i.caseId);
const task = (
  taskId: string,
  dueAt: string,
  o: Partial<DigestTask> = {}
): DigestTask => ({
  taskId,
  caseId: 'c1',
  title: taskId,
  ownerId: 'agentA',
  dueAt: new Date(dueAt),
  status: 'open',
  ...o,
});

describe('022d digest (pure)', () => {
  it('is a list: aiGenerated, generatedAt, four sections in a fixed order', async () => {
    const d = await build(mem([]));
    expect(d.aiGenerated).toBe(true);
    expect(d.generatedAt).toBe(NOW.toISOString());
    expect(d.sections.map((s) => s.kind)).toEqual([
      'stale_cases',
      'promises',
      'related',
      'followups',
    ]);
  });

  it('stale threshold: older than 3 days is stale, newer is not', async () => {
    const d = await build(
      mem([
        kase('old', { lastActivityAt: ago(3.5) }),
        kase('new', { lastActivityAt: ago(2.5) }),
      ])
    );
    expect(ids(d, 'stale_cases')).toEqual(['old']);
    expect(sec(d, 'stale_cases')[0]!.reason).toMatch(/^No activity for 3 days/);
    expect(sec(d, 'stale_cases')[0]!.label).toBe('B1 - Submitted');
  });

  it('closed cases are excluded (stage or closed date)', async () => {
    const d = await build(
      mem([
        kase('open', { lastActivityAt: ago(9) }),
        kase('declined', {
          stage: 'Declined',
          outcome: 'Declined',
          closedAt: ago(8),
          lastActivityAt: ago(8),
        }),
        kase('closed', {
          stage: 'Docs',
          closedAt: ago(7),
          lastActivityAt: ago(7),
          contactId: 'K9',
          bankCode: 'B9',
        }),
      ])
    );
    expect(ids(d, 'stale_cases')).toEqual(['open']);
  });

  it('a running snooze excludes the case; an ended snooze does not', async () => {
    const d = await build(
      mem([
        kase('snoozed', {
          lastActivityAt: ago(9),
          snoozedUntil: new Date(NOW.getTime() + DAY),
        }),
        kase('woke', { lastActivityAt: ago(8), snoozedUntil: ago(1) }),
      ])
    );
    expect(ids(d, 'stale_cases')).toEqual(['woke']);
  });

  it('promise detection: English and Arabic patterns; plain text is not a promise', () => {
    for (const t of [
      'I will send the letter',
      "i'll send it",
      'We will share the offer',
      'done by tomorrow',
      'by Thursday',
      'within 3 days',
      'shortly',
      ar(0x0633, 0x0623, 0x0631, 0x0633, 0x0644) +
        ' ' +
        ar(0x0627, 0x0644, 0x0645, 0x0633, 0x062a, 0x0646, 0x062f),
      ar(0x0628, 0x0643, 0x0631, 0x0629),
      ar(0x0642, 0x0631, 0x064a, 0x0628, 0x0627),
    ])
      expect(isPromise(t), t).toBe(true);
    for (const t of [
      'thanks for the documents',
      'received',
      'I sent it yesterday',
    ])
      expect(isPromise(t), t).toBe(false);
  });

  it('promises: EN and AR on open cases, message citation and dated reason', async () => {
    const d = await build(
      mem(
        [kase('c1'), kase('c2')],
        [
          msg(
            'm1',
            'c1',
            'I will send the salary certificate by tomorrow',
            ago(2)
          ),
          msg(
            'm2',
            'c2',
            ar(0x0633, 0x0623, 0x0631, 0x0633, 0x0644) +
              ' ' +
              ar(0x0627, 0x0644, 0x0639, 0x0631, 0x0636) +
              ' ' +
              ar(0x0642, 0x0631, 0x064a, 0x0628, 0x0627),
            ago(1)
          ),
        ]
      )
    );
    expect(sec(d, 'promises').map((i) => i.citation)).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'message', id: 'm2' },
    ]);
    expect(sec(d, 'promises')[0]!.reason).toBe(
      `Promise made on ${ago(2).toISOString().slice(0, 10)}: I will send the salary certificate by tomorrow`
    );
  });

  it('a later staff message clears the promise; closed cases and >14 days are dropped', async () => {
    const d = await build(
      mem(
        [
          kase('c1'),
          kase('c2'),
          kase('c3', {
            stage: 'Approved',
            outcome: 'Approved',
            closedAt: ago(1),
          }),
          kase('c4'),
        ],
        [
          msg('m1', 'c1', 'I will send it by tomorrow', ago(3)),
          msg('m1b', 'c1', 'sent, please check', ago(2)),
          msg('m2', 'c2', 'thanks', ago(4)),
          msg('m2b', 'c2', 'will share the statement shortly', ago(2)),
          msg('m3', 'c3', 'I will send it', ago(2)),
          msg('m4', 'c4', 'I will send it', ago(15)),
        ]
      )
    );
    expect(sec(d, 'promises').map((i) => i.citation!.id)).toEqual(['m2b']);
  });

  it('a promise in chunk 1 of a two-chunk reply is reported (same source, chunk 2 later)', async () => {
    const d = await build(
      mem(
        [kase('c1')],
        [
          {
            ...msg('m1a', 'c1', 'I will send it by tomorrow', ago(2)),
            sourceId: 's1',
          },
          {
            ...msg(
              'm1b',
              'c1',
              'thanks for your patience',
              new Date(ago(2).getTime() + 1000)
            ),
            sourceId: 's1',
          },
        ]
      )
    );
    expect(sec(d, 'promises').map((i) => i.citation)).toEqual([
      { kind: 'message', id: 'm1a' },
    ]);
  });

  it('a newer separate source without a promise hides an older promise', async () => {
    const d = await build(
      mem(
        [kase('c1')],
        [
          {
            ...msg('m1', 'c1', 'I will send it by tomorrow', ago(3)),
            sourceId: 's1',
          },
          { ...msg('m2', 'c1', 'sent, please check', ago(2)), sourceId: 's2' },
        ]
      )
    );
    expect(sec(d, 'promises')).toEqual([]);
  });

  it('snippets are at most 120 characters', async () => {
    const long = `I will send ${'x'.repeat(300)}`;
    expect(snippet(long).length).toBe(120);
    const d = await build(mem([kase('c1')], [msg('m1', 'c1', long, ago(1))]));
    const reason = sec(d, 'promises')[0]!.reason;
    expect(reason.slice(reason.indexOf(': ') + 2).length).toBeLessThanOrEqual(
      120
    );
  });

  it('each section is capped at 10 items', async () => {
    const cases = Array.from({ length: 15 }, (_, i) =>
      kase(`c${String(i).padStart(2, '0')}`, {
        lastActivityAt: ago(5 + i),
        bankCode: `B${i}`,
        contactId: `K${i}`,
      })
    );
    const messages = cases.map((c, i) =>
      msg(`m${i}`, c.caseId, 'I will send it', ago(1), c.contactId!)
    );
    const closed = cases.map((c, i) =>
      kase(`z${i}`, {
        stage: 'Declined',
        outcome: 'Declined',
        closedAt: ago(30),
        contactId: c.contactId,
        bankCode: c.bankCode,
      })
    );
    const tasks = Array.from({ length: 15 }, (_, i) =>
      task(`t${i}`, ago(1).toISOString(), { caseId: 'c00' })
    );
    const d = await build(mem([...cases, ...closed], messages, tasks));
    for (const s of d.sections) expect(s.items.length, s.kind).toBe(10);
  });

  it('related: same contact first, then same bank, max 2, outcome + date + id only', async () => {
    const d = await build(
      mem(
        [
          kase('s1', { lastActivityAt: ago(6) }),
          kase('r1', {
            stage: 'Closed',
            outcome: 'Approved',
            closedAt: ago(20),
          }),
          kase('r2', {
            stage: 'Declined',
            outcome: 'Declined',
            closedAt: ago(10),
            contactId: 'K2',
          }),
          kase('r3', {
            stage: 'Withdrawn',
            outcome: 'Withdrawn',
            closedAt: ago(40),
            contactId: 'K3',
          }),
          kase('x1', {
            stage: 'Closed',
            outcome: 'Declined',
            closedAt: ago(5),
            contactId: 'K4',
            bankCode: 'B7',
          }),
        ],
        [msg('mK2', 'r2', 'SECRET-K2 salary 25000', ago(1), 'K2')]
      )
    );
    const rel = sec(d, 'related');
    expect(rel.map((i) => i.citation!.id)).toEqual(['r1', 'r2']);
    expect(rel.every((i) => i.caseId === 's1')).toBe(true);
    expect(rel[1]!.reason).toBe(
      `Declined on ${ago(10).toISOString().slice(0, 10)}`
    );
    expect(JSON.stringify(d)).not.toContain('SECRET-K2');
  });

  it('related: a case with no bank matches no other bankless case', async () => {
    const d = await build(
      mem([
        kase('s1', { lastActivityAt: ago(6), bankCode: null, contactId: null }),
        kase('r1', {
          stage: 'Closed',
          outcome: 'Approved',
          closedAt: ago(20),
          bankCode: null,
          contactId: 'K5',
        }),
      ])
    );
    expect(sec(d, 'related')).toEqual([]);
    expect(sec(d, 'stale_cases')[0]!.label).toBe('No bank - Submitted');
  });

  it("followups: the actor's own open tasks due before the end of the Dubai day", async () => {
    const late = new Date('2026-11-11T19:30:00Z'); // 23:30 Dubai
    expect(endOfDubaiDay(late).toISOString()).toBe('2026-11-11T20:00:00.000Z');
    expect(endOfDubaiDay(new Date('2026-11-11T20:30:00Z')).toISOString()).toBe(
      '2026-11-12T20:00:00.000Z'
    );
    const tasks = [
      task('in', '2026-11-11T19:59:00Z'),
      task('out', '2026-11-11T20:01:00Z'),
      task('other', '2026-11-11T10:00:00Z', { ownerId: 'agentB' }),
      task('done', '2026-11-11T10:00:00Z', { status: 'done' }),
      task('overdue', '2026-11-10T10:00:00Z'),
    ];
    const d = await build(mem([kase('c1')], [], tasks), late);
    expect(sec(d, 'followups').map((i) => i.citation!.id)).toEqual([
      'overdue',
      'in',
    ]);
  });

  it('Dubai midnight (20:00Z) moves what counts as due today', async () => {
    // A task due at 2026-11-13T10:00Z (14:00 Dubai on the 13th).
    const tasks = [task('tomorrow', '2026-11-13T10:00:00Z')];
    const before = await build(
      mem([], [], tasks),
      new Date('2026-11-12T19:59:00Z') // 23:59 Dubai, the 12th
    );
    const after = await build(
      mem([], [], tasks),
      new Date('2026-11-12T20:01:00Z') // 00:01 Dubai, the 13th
    );
    expect(sec(before, 'followups')).toEqual([]);
    expect(sec(after, 'followups').map((i) => i.citation!.id)).toEqual([
      'tomorrow',
    ]);
    expect(sec(after, 'followups')[0]!.reason).toBe(
      'Due today at 2026-11-13T10:00:00.000Z'
    );
  });
});
