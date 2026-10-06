import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { TEAM_ACTIVITY_DEFAULTS } from './limits';
import {
  parseTeamActivityReport,
  type NumberActivity,
  type SenderActivity,
  type TeamActivityReport,
} from './report';
import {
  adviceFor,
  assessReport,
  findingArgs,
  flattenFindings,
  levelOf,
  numberFindings,
  replyRateBand,
  senderFindings,
  statusOf,
  worseLevel,
  type Finding,
  type FindingCode,
} from './risk';

const limits = { ...TEAM_ACTIVITY_DEFAULTS };

function sender(over: Partial<SenderActivity> = {}): SenderActivity {
  const base = parseTeamActivityReport({
    senders: [{ kind: 'person', user_id: 'u1', name: 'Sara' }],
  }).senders[0];
  return { ...base, ...over };
}

function number(over: Partial<NumberActivity> = {}): NumberActivity {
  const base = parseTeamActivityReport({
    numbers: [{ channel_id: 'w1', provider: 'whapi', status: 'connected' }],
  }).numbers[0];
  return { ...base, ...over };
}

const codes = (fs: { code: string }[]) => fs.map((f) => f.code);
const find = (fs: Finding[], code: FindingCode) =>
  fs.find((f) => f.code === code);

describe('reply rate (D3, D4)', () => {
  it('needs 5 mature chats', () => {
    expect(replyRateBand(4, 4, 30)).toBeNull();
    expect(replyRateBand(5, 5, 30)).toBe('low');
  });

  it('compares the unrounded rate with >=', () => {
    // 29.6% rounds to 30 but is below a 30% minimum.
    expect(replyRateBand(250, 176, 30)).toBe('low');
    // Exactly the minimum is not low, but close.
    expect(replyRateBand(10, 7, 30)).toBe('close');
    // 39.9% is still close; 40% is fine.
    expect(replyRateBand(1000, 601, 30)).toBe('close');
    expect(replyRateBand(10, 6, 30)).toBeNull();
  });

  it('uses mature chats only, so pending ones do not count as unanswered', () => {
    const s = sender({
      chatsStarted: 20,
      noReply: 15,
      matureStarted: 10,
      matureNoReply: 5,
      pendingReply: 10,
    });
    expect(codes(senderFindings(s, { limits }))).toEqual([]);
  });

  it('words the two bands differently', () => {
    const low = senderFindings(
      sender({ matureStarted: 10, matureNoReply: 8 }),
      { limits }
    );
    expect(find(low, 'reply_rate_low')).toMatchObject({
      level: 'act_now',
      values: { replied: 2, total: 10, min: 30 },
      labels: { name: 'Sara' },
    });
    const close = senderFindings(
      sender({ matureStarted: 1000, matureNoReply: 604 }),
      { limits }
    );
    // 39.6% shows as 39, never rounded up to the margin.
    expect(find(close, 'reply_rate_close')).toMatchObject({
      level: 'keep_an_eye',
      values: { rate: 39, min: 30 },
    });
  });
});

describe('person findings', () => {
  it('flags nothing for a quiet member', () => {
    expect(senderFindings(sender(), { limits })).toEqual([]);
  });

  it('is act-now at the daily limit itself (D5)', () => {
    const at = senderFindings(sender({ todayStarts: 20 }), { limits });
    expect(find(at, 'over_limit_today')).toMatchObject({
      level: 'act_now',
      audience: 'leader',
      values: { count: 20, limit: 20 },
    });
    expect(
      find(
        senderFindings(sender({ todayStarts: 19 }), { limits }),
        'over_limit_today'
      )
    ).toBeUndefined();
  });

  it('grades chasing per D7', () => {
    const one = sender({ chaseNew: 1, conversations: 20 });
    expect(find(senderFindings(one, { limits }), 'chase_new')?.level).toBe(
      'keep_an_eye'
    );
    const three = sender({ chaseNew: 3, conversations: 100 });
    expect(find(senderFindings(three, { limits }), 'chase_new')?.level).toBe(
      'act_now'
    );
    // A quarter of the person's chats chased: act now, both kinds.
    const share = sender({ chaseNew: 1, chaseExisting: 1, conversations: 8 });
    const fs = senderFindings(share, { limits });
    expect(find(fs, 'chase_new')?.level).toBe('act_now');
    expect(find(fs, 'chase_existing')?.level).toBe('act_now');
    const existing = sender({ chaseExisting: 2, conversations: 20 });
    expect(
      find(senderFindings(existing, { limits }), 'chase_existing')
    ).toMatchObject({ level: 'keep_an_eye', values: { count: 2, limit: 3 } });
  });

  it('counts only phone-number failures (D10)', () => {
    const official = sender({
      messagesSent: 20,
      failed: 10,
      failedOfficial: 10,
    });
    expect(codes(senderFindings(official, { limits }))).toEqual([]);
    const phone = sender({ messagesSent: 20, failed: 3, failedPhone: 3 });
    expect(codes(senderFindings(phone, { limits }))).toEqual(['failed_sends']);
  });

  it('flags habits: bursts, links, similar first messages, night, waiting', () => {
    const fs = senderFindings(
      sender({
        burst10min: 10,
        linksFirst: 3,
        similarOpeners: 3,
        nightStarts: 3,
        waitingRecent: 5,
        waitingOlder: 50,
      }),
      { limits }
    );
    expect(codes(fs).sort()).toEqual(
      [
        'burst',
        'links_first',
        'night_starts',
        'similar_openers',
        'waiting',
      ].sort()
    );
    expect(find(fs, 'night_starts')?.labels).toMatchObject({
      late: '22:00',
      early: '08:00',
    });
    // Older waiting chats alone are not today's problem (D11).
    expect(
      codes(
        senderFindings(sender({ waitingRecent: 4, waitingOlder: 50 }), {
          limits,
        })
      )
    ).toEqual([]);
  });

  it('puts act-now first, then today before habits', () => {
    const fs = senderFindings(
      sender({ nightStarts: 5, todayStarts: 25, linksFirst: 4 }),
      { limits }
    );
    expect(codes(fs)).toEqual([
      'over_limit_today',
      'links_first',
      'night_starts',
    ]);
  });

  it('still accepts the bare limits (068 call sites)', () => {
    expect(codes(senderFindings(sender({ todayStarts: 20 }), limits))).toEqual([
      'over_limit_today',
    ]);
  });
});

describe('API and bot senders (D9)', () => {
  const api = (over: Partial<SenderActivity> = {}) =>
    sender({ kind: 'api', userId: null, name: null, ...over });

  it('get owner findings only, never person ones', () => {
    const fs = senderFindings(
      api({
        todayStarts: 99,
        burst10min: 99,
        matureStarted: 10,
        matureNoReply: 9,
        linksFirst: 2,
        failedPhone: 9,
        messagesSent: 10,
        nightStarts: 9,
      }),
      { limits }
    );
    expect(codes(fs)).toEqual(['auto_review']);
    expect(fs[0]).toMatchObject({
      audience: 'owner',
      values: { count: 10, rate: 10 },
      labels: { who: 'api' },
    });
  });

  it('names the bot and reports chasing', () => {
    const fs = senderFindings(
      sender({ kind: 'bot', userId: null, chaseNew: 1 }),
      { limits }
    );
    expect(fs).toMatchObject([
      { code: 'auto_chasing', audience: 'owner', labels: { who: 'bot' } },
    ]);
  });
});

describe('number findings', () => {
  it('is act-now at the limit (D5) and a warning from 80%', () => {
    const at = numberFindings(number({ numberTodayStarted: 50 }), { limits });
    expect(find(at, 'number_at_limit')).toMatchObject({
      level: 'act_now',
      values: { count: 50, limit: 50 },
    });
    expect(
      codes(numberFindings(number({ numberTodayStarted: 40 }), { limits }))
    ).toEqual(['number_near_limit']);
    expect(
      numberFindings(number({ numberTodayStarted: 39 }), { limits })
    ).toEqual([]);
  });

  it('uses the warm-up limit for a new number (D6)', () => {
    const n = number({
      warmingUp: true,
      ageDays: 3,
      effectiveDailyLimit: 10,
      numberTodayStarted: 10,
    });
    const fs = numberFindings(n, { limits });
    expect(codes(fs)).toEqual(['number_at_limit', 'number_warming_up']);
    expect(find(fs, 'number_warming_up')?.values).toEqual({
      days: 3,
      limit: 10,
    });
  });

  it("judges the whole number's day in team scope", () => {
    const fs = numberFindings(
      number({ todayStarts: 2, numberTodayStarted: 50 }),
      { limits }
    );
    expect(codes(fs)).toEqual(['number_at_limit']);
  });

  it('judges phone numbers only', () => {
    const official = number({
      kind: 'official',
      provider: 'meta',
      effectiveDailyLimit: null,
      numberTodayStarted: 500,
      status: 'disconnected',
      matureStarted: 50,
      matureNoReply: 50,
    });
    expect(numberFindings(official, { limits })).toEqual([]);
  });

  it('flags a disconnected number, its reply rate and days at the limit', () => {
    const fs = numberFindings(
      number({
        status: 'disconnected',
        matureStarted: 5,
        matureNoReply: 5,
        daysAtLimit: 2,
      }),
      { limits }
    );
    expect(codes(fs)).toEqual([
      'number_disconnected',
      'number_reply_rate_low',
      'number_over_limit_days',
    ]);
  });

  it('makes the safety rating an owner finding', () => {
    const rating = (riskFactor: number) => ({
      riskFactor,
      lifeTime: null,
      riskFactorChats: null,
      riskFactorContacts: null,
    });
    expect(numberFindings(number(), { limits }, rating(1))).toMatchObject([
      { code: 'number_safety_low', level: 'act_now', audience: 'owner' },
    ]);
    expect(numberFindings(number(), { limits }, rating(2))[0].level).toBe(
      'keep_an_eye'
    );
    expect(numberFindings(number(), { limits }, rating(3))).toEqual([]);
  });
});

describe('assessReport', () => {
  function report(over: Partial<TeamActivityReport> = {}): TeamActivityReport {
    return {
      ...parseTeamActivityReport({ generated_at: '2026-10-01T09:00:00Z' }),
      senders: [
        sender({ userId: 'u1', name: 'Sara', nightStarts: 3 }),
        sender({ userId: 'u2', name: 'Ali', todayStarts: 25 }),
        sender({ userId: 'u3', name: 'Quiet' }),
        sender({ kind: 'api', userId: null, chaseNew: 3 }),
      ],
      numbers: [number({ numberTodayStarted: 50 })],
      waitingUnassignedRecent: 3,
      ...over,
    };
  }
  const safety = () => ({
    riskFactor: 1,
    lifeTime: null,
    riskFactorChats: null,
    riskFactorContacts: null,
  });

  it('gives each person a status and one line of advice', () => {
    const a = assessReport(report(), { viewer: 'owner' });
    expect(
      a.people.map((p) => [p.sender.name, p.status, p.advice.key])
    ).toEqual([
      ['Sara', 'watch', 'night_starts'],
      ['Ali', 'act', 'over_limit_today'],
      ['Quiet', 'fine', 'quiet'],
    ]);
    expect(adviceFor(sender({ messagesSent: 3 }), []).key).toBe('fine');
  });

  it('routes API and Safety Meter findings to the owner section', () => {
    const a = assessReport(report(), { viewer: 'owner', safety });
    expect(codes(a.owner)).toEqual(['number_safety_low', 'auto_chasing']);
    // One card per person or number: the number's safety rating rides
    // along under its limit card instead of taking a slot.
    expect(codes(a.today)).toEqual([
      'over_limit_today',
      'number_at_limit',
      'auto_chasing',
      'waiting_unassigned',
      'night_starts',
    ]);
    const limitCard = a.today.find((f) => f.code === 'number_at_limit')!;
    expect(codes(a.todayMore[limitCard.id])).toEqual(['number_safety_low']);
  });

  it('gives one person with many problems a single card', () => {
    const busy = sender({
      userId: 'busy',
      name: 'Busy',
      todayStarts: 25,
      nightStarts: 5,
      linksFirst: 4,
    });
    const a = assessReport(report({ senders: [busy] }), { viewer: 'leader' });
    const cards = a.today.filter(
      (f) => f.subject.type === 'person' && f.subject.userId === 'busy'
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].code).toBe('over_limit_today');
    expect(codes(a.todayMore[cards[0].id])).toEqual(
      expect.arrayContaining(['night_starts', 'links_first'])
    );
  });

  it('hides owner findings from a leader and in team scope', () => {
    for (const a of [
      assessReport(report(), { viewer: 'leader', safety }),
      assessReport(report({ scope: 'team' }), { viewer: 'owner', safety }),
    ]) {
      expect(a.owner).toEqual([]);
      expect(a.today.every((f) => f.audience === 'leader')).toBe(true);
      expect(codes(a.numbers[0].findings)).toEqual(['number_at_limit']);
    }
  });

  it('keeps the today list short', () => {
    const a = assessReport(report(), { viewer: 'owner', todayLimit: 2 });
    expect(codes(a.today)).toEqual(['over_limit_today', 'number_at_limit']);
  });
});

describe('levels', () => {
  it('maps findings to a status and the 068 level', () => {
    const fs = senderFindings(sender({ todayStarts: 20 }), { limits });
    expect(statusOf(fs)).toBe('act');
    expect(levelOf(fs)).toBe('at_risk');
    expect(fs[0].severity).toBe('critical');
    expect(statusOf([])).toBe('fine');
    expect(worseLevel('watch', 'at_risk')).toBe('at_risk');
  });

  it('flattens act-now first, keeping subject order within a level', () => {
    const a = senderFindings(sender({ nightStarts: 5 }), { limits });
    const b = senderFindings(sender({ todayStarts: 25 }), { limits });
    const rows = flattenFindings([
      { subject: 'a', findings: a, level: levelOf(a) },
      { subject: 'b', findings: b, level: levelOf(b) },
    ]);
    expect(rows.map((r) => r.subject)).toEqual(['b', 'a']);
  });
});

describe('finding wording', () => {
  const catalogue = (locale: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')
    );
  it.each(['en', 'ko'])('every finding renders in %s', (locale) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: catalogue(locale),
      namespace: 'TeamActivity.findings',
      onError: (e) => errors.push(e.message),
    });
    const bodies: string[] = [];
    const fs: Finding[] = [
      ...senderFindings(
        sender({
          matureStarted: 10,
          matureNoReply: 8,
          todayStarts: 30,
          daysAtLimit: 2,
          burst10min: 20,
          chaseNew: 1,
          chaseExisting: 1,
          linksFirst: 5,
          similarOpeners: 5,
          nightStarts: 5,
          failedPhone: 5,
          messagesSent: 10,
          waitingRecent: 9,
        }),
        { limits }
      ),
      ...senderFindings(sender({ matureStarted: 10, matureNoReply: 7 }), {
        limits,
      }),
      ...senderFindings(
        sender({
          kind: 'bot',
          userId: null,
          matureStarted: 10,
          matureNoReply: 9,
          linksFirst: 1,
          chaseNew: 1,
        }),
        { limits }
      ),
      ...senderFindings(
        sender({
          kind: 'api',
          userId: null,
          matureStarted: 10,
          matureNoReply: 9,
        }),
        { limits }
      ),
      ...senderFindings(sender({ kind: 'api', userId: null, linksFirst: 3 }), {
        limits,
      }),
      ...numberFindings(
        number({
          status: 'qr',
          warmingUp: true,
          ageDays: 1,
          effectiveDailyLimit: 10,
          numberTodayStarted: 10,
          daysAtLimit: 1,
          matureStarted: 10,
          matureNoReply: 10,
        }),
        { limits },
        {
          riskFactor: 1,
          lifeTime: null,
          riskFactorChats: null,
          riskFactorContacts: null,
        }
      ),
      ...numberFindings(
        number({ numberTodayStarted: 45, matureStarted: 10, matureNoReply: 7 }),
        { limits }
      ),
      ...assessReport(
        { ...parseTeamActivityReport({}), waitingUnassignedRecent: 4 },
        { viewer: 'leader' }
      ).account,
    ];
    for (const f of fs) {
      t(f.titleKey as never, findingArgs(f) as never);
      bodies.push(t(f.bodyKey as never, findingArgs(f) as never));
    }
    expect(errors).toEqual([]);
    // Every code in the catalogue was exercised.
    const covered = new Set(fs.map((f) => f.code));
    expect([...covered].sort()).toEqual(
      Object.keys(catalogue(locale).TeamActivity.findings).sort()
    );
    if (locale === 'en') {
      const banned =
        /\b(starts?|runs?|bursts?|openers?|providers?|whapi|meta|median|p50)\b/i;
      expect(bodies.filter((b) => banned.test(b))).toEqual([]);
    }
  });

  it.each(['en', 'ko'])('every advice key exists in %s', (locale) => {
    const advice = catalogue(locale).TeamActivity.advice;
    const keys = Object.keys(catalogue('en').TeamActivity.findings).filter(
      (k) =>
        !k.startsWith('number_') &&
        !k.startsWith('auto_') &&
        k !== 'waiting_unassigned'
    );
    for (const k of [...keys, 'fine', 'quiet']) expect(advice[k]).toBeTruthy();
  });
});
