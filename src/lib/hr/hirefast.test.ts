/** Hire fast: every score component, ordering, ties, reasons, exclusions. */
import { describe, expect, it } from 'vitest';

import {
  HIREFAST_REASONS,
  filterCandidates,
  hireFastViews,
  overdueConversationIds,
  rankCandidates,
  reasonLabelKey,
  scoreCandidate,
  stalledAfterHours,
  waitingLabel,
  type HireFastRow,
  type HireFastSource,
} from './hirefast';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
let n = 0;
const conv = (p: Partial<HireFastSource> = {}): HireFastSource => ({
  conversation_id: `c${String(++n).padStart(3, '0')}`,
  inbox: 'recruiter',
  stage_key: 'cv_review',
  urgent: false,
  upset: false,
  reply_state: 'reply_due',
  last_inbound_at: ago(0),
  last_outbound_at: null,
  closed_at: null,
  created_at: ago(0),
  ...p,
});
const NONE = new Set<string>();
const sc = (
  p: Partial<HireFastSource>,
  tasks: ReadonlySet<string> = NONE,
  stalled: number | null = 72
) => scoreCandidate(conv(p), NOW, tasks, stalled);

describe('hire fast scoring', () => {
  it('reply due / new: 100 + reply_due; waiting on them: 10, no reason', () => {
    expect(sc({})).toMatchObject({
      score: 100,
      reasons: ['reply_due'],
      waitingHours: 0,
    });
    expect(
      sc({ reply_state: 'new', last_inbound_at: null, created_at: ago(0) })
    ).toMatchObject({ score: 100, reasons: ['reply_due'] });
    expect(
      sc({ reply_state: 'waiting', last_outbound_at: ago(0) })
    ).toMatchObject({ score: 10, reasons: [], waitingHours: 0 });
  });

  it('urgent +50, upset +30', () => {
    expect(sc({ urgent: true })).toMatchObject({
      score: 150,
      reasons: ['reply_due', 'urgent'],
    });
    expect(sc({ upset: true })).toMatchObject({
      score: 130,
      reasons: ['reply_due', 'upset'],
    });
  });

  it('hours waited: 1/hour capped 72; waiting_long from 24 h; new counts from creation', () => {
    expect(sc({ last_inbound_at: ago(5) })).toMatchObject({
      score: 105,
      waitingHours: 5,
      reasons: ['reply_due'],
    });
    expect(sc({ last_inbound_at: ago(23) }).reasons).toEqual(['reply_due']);
    expect(sc({ last_inbound_at: ago(24) })).toMatchObject({
      score: 124,
      reasons: ['reply_due', 'waiting_long'],
    });
    expect(sc({ last_inbound_at: ago(200) })).toMatchObject({
      score: 172,
      waitingHours: 200,
    });
    expect(
      sc({ reply_state: 'new', last_inbound_at: null, created_at: ago(3) })
    ).toMatchObject({ score: 103, waitingHours: 3 });
    // Waiting on them: no hours, however old the last inbound.
    expect(
      sc({
        reply_state: 'waiting',
        last_inbound_at: ago(50),
        last_outbound_at: ago(1),
      })
    ).toMatchObject({ score: 10, waitingHours: 0, reasons: [] });
  });

  it('stage weight 0 / 5 / 10 / 15; late_stage from hr_interview; null 0', () => {
    expect(
      (
        [
          null,
          'cv_review',
          'ai_interview',
          'hr_interview',
          'manager_interview',
        ] as const
      ).map((s) => sc({ stage_key: s }).score)
    ).toEqual([100, 100, 105, 110, 115]);
    expect(sc({ stage_key: 'ai_interview' }).reasons).toEqual(['reply_due']);
    expect(sc({ stage_key: 'hr_interview' }).reasons).toEqual([
      'reply_due',
      'late_stage',
    ]);
    expect(sc({ stage_key: 'manager_interview' }).reasons).toEqual([
      'reply_due',
      'late_stage',
    ]);
  });

  it('open overdue task +20 task_overdue', () => {
    const c = conv();
    expect(
      scoreCandidate(c, NOW, new Set([c.conversation_id]), null)
    ).toMatchObject({ score: 120, reasons: ['reply_due', 'task_overdue'] });
  });

  it('stalled: waiting, no activity over after_hours +20; not on us, not at the threshold, not without a rule', () => {
    const quiet = {
      reply_state: 'waiting' as const,
      created_at: ago(100),
      last_inbound_at: ago(100),
    };
    expect(sc({ ...quiet, last_outbound_at: ago(73) }, NONE, 72)).toMatchObject(
      { score: 30, reasons: ['stalled'] }
    );
    expect(
      sc({ ...quiet, last_outbound_at: ago(72) }, NONE, 72).reasons
    ).toEqual([]);
    expect(
      sc({ ...quiet, last_outbound_at: ago(73) }, NONE, null).reasons
    ).toEqual([]);
    expect(
      sc({ last_inbound_at: ago(10), last_outbound_at: ago(80) }, NONE, 5)
        .reasons
    ).toEqual(['reply_due']);
  });

  it('every reason is one of the seven codes', () => {
    const all = sc(
      {
        urgent: true,
        upset: true,
        stage_key: 'manager_interview',
        last_inbound_at: ago(30),
      },
      NONE,
      1
    );
    const c = conv({
      reply_state: 'waiting',
      created_at: ago(90),
      last_inbound_at: ago(90),
      last_outbound_at: ago(80),
    });
    const stalled = scoreCandidate(c, NOW, new Set([c.conversation_id]), 1);
    for (const r of [...all.reasons, ...stalled.reasons])
      expect(HIREFAST_REASONS).toContain(r);
    expect(new Set([...all.reasons, ...stalled.reasons])).toEqual(
      new Set(HIREFAST_REASONS)
    );
  });
});

describe('stalledAfterHours', () => {
  const rule = (key: string, after_hours: number | null, enabled = true) =>
    ({ key, after_hours, enabled }) as Parameters<
      typeof stalledAfterHours
    >[0][number];

  it('is the enabled no_activity_recruiter rule hours', () => {
    expect(
      stalledAfterHours([
        rule('reply_overdue_recruiter', 2),
        rule('no_activity_recruiter', 48),
      ])
    ).toBe(48);
  });

  it('is null when the rule is disabled, missing or has no hours', () => {
    expect(stalledAfterHours([rule('no_activity_recruiter', 48, false)])).toBe(
      null
    );
    expect(stalledAfterHours([rule('reply_overdue_recruiter', 2)])).toBe(null);
    expect(stalledAfterHours([rule('no_activity_recruiter', null)])).toBe(null);
    expect(stalledAfterHours([])).toBe(null);
  });
});

describe('overdueConversationIds', () => {
  it('takes open HR tasks past due, by the chat in source_ref', () => {
    const ids = overdueConversationIds(
      [
        { status: 'open', due_at: ago(1), source_ref: 'hr:c1:stage_x:e1' },
        { status: 'open', due_at: ago(-1), source_ref: 'hr:c2:r:e' },
        { status: 'done', due_at: ago(5), source_ref: 'hr:c3:r:e' },
        { status: 'open', due_at: ago(5), source_ref: 'pbx:c4' },
        { status: 'open', due_at: null, source_ref: 'hr:c5:r:e' },
        { status: 'open', due_at: ago(5), source_ref: null },
      ],
      NOW
    );
    expect([...ids]).toEqual(['c1']);
  });
});

describe('hire fast ordering', () => {
  it('orders by score; urgent beats an older plain reply', () => {
    const old = conv({ last_inbound_at: ago(40) });
    const urg = conv({ urgent: true, last_inbound_at: ago(1) });
    const w = conv({ reply_state: 'waiting', last_outbound_at: ago(1) });
    const out = rankCandidates([w, old, urg], NOW, NONE, 72);
    expect(out.map((x) => x.conversationId)).toEqual([
      urg.conversation_id,
      old.conversation_id,
      w.conversation_id,
    ]);
    expect(out.map((x) => x.score)).toEqual([151, 140, 10]);
  });

  it('ties: last inbound oldest first, none last, then id', () => {
    const base = { reply_state: 'waiting' as const, last_outbound_at: ago(1) };
    const a = conv({ ...base, last_inbound_at: ago(2) });
    const b = conv({ ...base, last_inbound_at: ago(9) });
    const c = conv({ ...base, last_inbound_at: null });
    const d = conv({ ...base, last_inbound_at: null });
    expect(
      rankCandidates([d, c, a, b], NOW, NONE, 72).map((x) => x.conversationId)
    ).toEqual([b, a, c, d].map((x) => x.conversation_id));
  });

  it('excludes closed and dept rows; limit', () => {
    const keep = [conv(), conv(), conv()];
    const rows = [
      ...keep,
      conv({ closed_at: ago(1) }),
      conv({ inbox: 'dept', stage_key: null, urgent: true }),
    ];
    expect(
      rankCandidates(rows, NOW, NONE, 72)
        .map((x) => x.conversationId)
        .sort()
    ).toEqual(keep.map((k) => k.conversation_id).sort());
    expect(rankCandidates(rows, NOW, NONE, 72, 2)).toHaveLength(2);
  });
});

describe('hire fast view', () => {
  const row = (
    p: Partial<HireFastSource>,
    chat: HireFastRow['chat']
  ): HireFastRow => ({ ...conv(p), chat });

  it('waitingLabel: hours up to 48, whole days past, nothing at 0', () => {
    expect(waitingLabel(0)).toBeNull();
    expect(waitingLabel(18)).toEqual({ key: 'waitingHours', n: 18 });
    expect(waitingLabel(48)).toEqual({ key: 'waitingHours', n: 48 });
    expect(waitingLabel(49)).toEqual({ key: 'waitingDays', n: 2 });
    expect(waitingLabel(80)).toEqual({ key: 'waitingDays', n: 3 });
  });

  it('reasonLabelKey maps each code under reason.*', () => {
    expect(HIREFAST_REASONS.map(reasonLabelKey)).toEqual(
      HIREFAST_REASONS.map((c) => `reason.${c}`)
    );
  });

  it('names a row by contact name, else phone, else null; links to the HR chat', () => {
    const a = row(
      { urgent: true },
      {
        assigned_agent_id: null,
        contact: { name: ' Sara ', phone: '+971500000001' },
      }
    );
    const b = row(
      { upset: true },
      {
        assigned_agent_id: null,
        contact: { name: '', phone: '+971500000002' },
      }
    );
    const c = row({}, null);
    const views = hireFastViews([c, b, a], NOW, NONE, null);
    expect(views.map((v) => v.name)).toEqual(['Sara', '+971500000002', null]);
    expect(views[0].href).toBe(`/hr/recruiter?c=${a.conversation_id}`);
  });

  it('filters by stage and by the viewer as assignee', () => {
    const mineRow = row(
      { stage_key: 'hr_interview' },
      {
        assigned_agent_id: 'u1',
        contact: null,
      }
    );
    const other = row(
      { stage_key: 'cv_review' },
      {
        assigned_agent_id: 'u2',
        contact: null,
      }
    );
    const rows = [mineRow, other];
    expect(
      filterCandidates(rows, { stage: null, mine: false, viewerId: 'u1' })
    ).toEqual(rows);
    expect(
      filterCandidates(rows, {
        stage: 'cv_review',
        mine: false,
        viewerId: 'u1',
      })
    ).toEqual([other]);
    expect(
      filterCandidates(rows, { stage: null, mine: true, viewerId: 'u1' })
    ).toEqual([mineRow]);
    expect(
      filterCandidates(rows, { stage: null, mine: true, viewerId: null })
    ).toEqual([]);
  });
});
