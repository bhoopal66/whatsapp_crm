/**
 * Ported from wacrm module 022d (daily digest, core; no route yet). A
 * per-actor LIST for staff: it never sends anything and stores nothing.
 * buildDigest is pure; every read goes through the DigestSource port
 * (SupabaseDigestSource in digest-store.ts). Sections:
 *   stale_cases - open, not snoozed, no activity for `staleDays` (default 3)
 *                 days, stalest first
 *   promises    - a staff message in the last 14 days that matches a
 *                 commitment pattern, on an open case, with no LATER staff
 *                 message on that case
 *   related     - for each stale / promise case, up to 2 closed cases with an
 *                 outcome sharing its contact (then its bank): outcome,
 *                 closed date and case id only, never item text
 *   followups   - the actor's own tasks, not done, due before the end of the
 *                 Asia/Dubai day (UTC+4, no DST), overdue included
 * At most 10 items per section; message snippets are at most 120 characters
 * of already-redacted brain item text.
 */
import { FINAL_STAGES } from '@/lib/cases/types';

export type DigestSectionKind =
  'stale_cases' | 'promises' | 'related' | 'followups';
export interface DigestItem {
  caseId: string;
  label: string;
  reason: string;
  citation?: { kind: 'case' | 'message' | 'task'; id: string };
}
export interface DigestSection {
  kind: DigestSectionKind;
  title: string;
  items: DigestItem[];
}
export interface Digest {
  generatedAt: string;
  aiGenerated: true;
  sections: DigestSection[];
}

export interface DigestCase {
  caseId: string;
  bankCode: string | null;
  stage: string;
  contactId: string | null;
  lastActivityAt: Date;
  snoozedUntil: Date | null;
  outcome: string | null;
  closedAt: Date | null;
}
export interface DigestMessage {
  itemId: string;
  caseId: string;
  contactId: string | null;
  text: string;
  createdBy: string;
  createdAt: Date;
}
export interface DigestTask {
  taskId: string;
  caseId: string;
  title: string;
  ownerId: string;
  dueAt: Date;
  status: string;
}

export interface DigestSource {
  /** Cases the actor may read in the account (closed ones are dropped). */
  cases(actorId: string, accountId: string, now: Date): Promise<DigestCase[]>;
  /** Staff messages the actor may see, created at or after `since`. */
  messages(
    actorId: string,
    accountId: string,
    since: Date
  ): Promise<DigestMessage[]>;
  /** Closed cases with an outcome the actor may read, sharing a contact or bank. */
  closedCases(
    actorId: string,
    accountId: string,
    contactIds: string[],
    bankCodes: string[]
  ): Promise<DigestCase[]>;
  /** The actor's tasks, not done, due before `before`. */
  tasksDueBefore(
    actorId: string,
    accountId: string,
    before: Date
  ): Promise<DigestTask[]>;
}

export const CLOSED_STAGES: ReadonlySet<string> = new Set(FINAL_STAGES);
export const DIGEST_SECTION_MAX = 10;
export const DIGEST_SNIPPET_MAX = 120;
export const DIGEST_STALE_DAYS = 3;
export const DIGEST_PROMISE_DAYS = 14;
export const DIGEST_RELATED_MAX = 2;
const DAY = 86_400_000;
const DUBAI_OFFSET = 4 * 3_600_000;

/**
 * Commitment patterns (case-insensitive). Arabic via escapes: bukra
 * (tomorrow), sa-ursil (I will send), qareeban (soon). Deliberately small.
 */
/** Arabic text from code points, so the source stays ASCII (brain.test.ts). */
export const ar = (...cps: number[]): string => String.fromCharCode(...cps);

export const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bi will send\b/i,
  /\bi'll send\b/i,
  /\bwill share\b/i,
  /\bby tomorrow\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bwithin \d+ days?\b/i,
  /\bshortly\b/i,
  new RegExp(ar(0x0628, 0x0643, 0x0631, 0x0629)),
  new RegExp(ar(0x0633, 0x0623, 0x0631, 0x0633, 0x0644)),
  new RegExp(ar(0x0642, 0x0631, 0x064a, 0x0628, 0x0627)),
];

export const isPromise = (text: string): boolean =>
  PROMISE_PATTERNS.some((p) => p.test(text));

export function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= DIGEST_SNIPPET_MAX
    ? t
    : `${t.slice(0, DIGEST_SNIPPET_MAX - 3)}...`;
}

/** The first instant after the Asia/Dubai (UTC+4, no DST) calendar day containing `now`. */
export function endOfDubaiDay(now: Date): Date {
  return new Date(
    Math.floor((now.getTime() + DUBAI_OFFSET) / DAY) * DAY + DAY - DUBAI_OFFSET
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const isClosed = (c: DigestCase) =>
  CLOSED_STAGES.has(c.stage) || c.closedAt !== null;
const cap = <T>(xs: T[]) => xs.slice(0, DIGEST_SECTION_MAX);
const label = (c: DigestCase) => `${c.bankCode ?? 'No bank'} - ${c.stage}`;

export async function buildDigest(input: {
  actorId: string;
  accountId: string;
  now: Date;
  source: DigestSource;
  staleDays?: number;
}): Promise<Digest> {
  const { actorId, accountId, now, source } = input;
  const staleDays = input.staleDays ?? DIGEST_STALE_DAYS;

  const all = await source.cases(actorId, accountId, now);
  const open = all.filter((c) => !isClosed(c));
  const openById = new Map(open.map((c) => [c.caseId, c]));

  const staleCut = now.getTime() - staleDays * DAY;
  const stale = open
    .filter(
      (c) => !(c.snoozedUntil && c.snoozedUntil.getTime() > now.getTime())
    )
    .filter((c) => c.lastActivityAt.getTime() < staleCut)
    .sort(
      (a, b) =>
        a.lastActivityAt.getTime() - b.lastActivityAt.getTime() ||
        a.caseId.localeCompare(b.caseId)
    );
  const staleItems: DigestItem[] = stale.map((c) => ({
    caseId: c.caseId,
    label: label(c),
    reason: `No activity for ${Math.floor((now.getTime() - c.lastActivityAt.getTime()) / DAY)} days (last ${day(c.lastActivityAt)})`,
    citation: { kind: 'case', id: c.caseId },
  }));

  const since = new Date(now.getTime() - DIGEST_PROMISE_DAYS * DAY);
  const msgs = (await source.messages(actorId, accountId, since)).filter(
    (m) =>
      m.createdAt.getTime() >= since.getTime() &&
      m.createdAt.getTime() <= now.getTime()
  );
  const promises: DigestMessage[] = [];
  for (const caseId of new Set(msgs.map((m) => m.caseId))) {
    if (!openById.has(caseId)) continue;
    const onCase = msgs.filter((x) => x.caseId === caseId);
    const p = onCase
      .filter((x) => isPromise(x.text))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!p) continue;
    // A promise only counts while no later staff message exists on the case.
    if (onCase.some((x) => x.createdAt.getTime() > p.createdAt.getTime()))
      continue;
    promises.push(p);
  }
  promises.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.itemId.localeCompare(b.itemId)
  );
  const promiseItems: DigestItem[] = promises.map((p) => ({
    caseId: p.caseId,
    label: label(openById.get(p.caseId)!),
    reason: `Promise made on ${day(p.createdAt)}: ${snippet(p.text)}`,
    citation: { kind: 'message', id: p.itemId },
  }));

  const targets = [
    ...new Map(
      [...stale, ...promises.map((p) => openById.get(p.caseId)!)].map((c) => [
        c.caseId,
        c,
      ])
    ).values(),
  ];
  const relatedItems: DigestItem[] = [];
  if (targets.length > 0) {
    const contacts = [
      ...new Set(
        targets.map((t) => t.contactId).filter((x): x is string => !!x)
      ),
    ];
    const banks = [
      ...new Set(
        targets.map((t) => t.bankCode).filter((x): x is string => !!x)
      ),
    ];
    const closed = (
      await source.closedCases(actorId, accountId, contacts, banks)
    )
      .filter((c) => isClosed(c) && c.outcome !== null && c.closedAt !== null)
      .sort(
        (a, b) =>
          b.closedAt!.getTime() - a.closedAt!.getTime() ||
          a.caseId.localeCompare(b.caseId)
      );
    for (const t of targets) {
      const sameContact = closed.filter(
        (c) =>
          t.contactId !== null &&
          c.contactId === t.contactId &&
          c.caseId !== t.caseId
      );
      const sameBank = closed.filter(
        (c) =>
          t.bankCode !== null &&
          c.bankCode === t.bankCode &&
          c.caseId !== t.caseId &&
          !sameContact.includes(c)
      );
      for (const c of [...sameContact, ...sameBank].slice(
        0,
        DIGEST_RELATED_MAX
      )) {
        relatedItems.push({
          caseId: t.caseId,
          label: `Closed case ${c.caseId} (${sameContact.includes(c) ? 'same contact' : 'same bank'})`,
          reason: `${c.outcome} on ${day(c.closedAt!)}`,
          citation: { kind: 'case', id: c.caseId },
        });
      }
    }
  }

  const end = endOfDubaiDay(now);
  const tasks = (await source.tasksDueBefore(actorId, accountId, end))
    .filter(
      (t) =>
        t.ownerId === actorId &&
        t.status !== 'done' &&
        t.dueAt.getTime() < end.getTime()
    )
    .sort(
      (a, b) =>
        a.dueAt.getTime() - b.dueAt.getTime() ||
        a.taskId.localeCompare(b.taskId)
    );
  const followItems: DigestItem[] = tasks.map((t) => ({
    caseId: t.caseId,
    label: t.title,
    reason:
      t.dueAt.getTime() < now.getTime()
        ? `Overdue since ${t.dueAt.toISOString()}`
        : `Due today at ${t.dueAt.toISOString()}`,
    citation: { kind: 'task', id: t.taskId },
  }));

  return {
    generatedAt: now.toISOString(),
    aiGenerated: true,
    sections: [
      {
        kind: 'stale_cases',
        title: `Cases with no activity for ${staleDays}+ days`,
        items: cap(staleItems),
      },
      {
        kind: 'promises',
        title: 'Promises awaiting follow-through',
        items: cap(promiseItems),
      },
      {
        kind: 'related',
        title: 'Related closed cases',
        items: cap(relatedItems),
      },
      {
        kind: 'followups',
        title: 'Your follow-ups due today (Dubai)',
        items: cap(followItems),
      },
    ],
  };
}
