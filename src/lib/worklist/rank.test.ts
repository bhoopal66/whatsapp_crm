import { describe, expect, it } from 'vitest';

import { HIREFAST_WEIGHTS } from '@/lib/hr/hirefast';

import {
  rankWorklist,
  worklistKindKey,
  worklistMode,
  worklistReasonLabel,
  WORKLIST_OWN_REASONS,
  WORKLIST_WEIGHTS,
  type WorklistCase,
  type WorklistDraft,
  type WorklistHrConversation,
  type WorklistHrTask,
  type WorklistInputs,
  type WorklistScope,
} from './rank';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const C1 = 'c0000001-0000-4000-8000-000000000000';

const conv = (
  over: Partial<WorklistHrConversation> = {}
): WorklistHrConversation => ({
  conversation_id: C1,
  inbox: 'recruiter',
  stage_key: null,
  urgent: false,
  upset: false,
  reply_state: 'waiting',
  last_inbound_at: null,
  last_outbound_at: null,
  closed_at: null,
  created_at: ago(1),
  ownerId: 'u-agent',
  ...over,
});
const kase = (over: Partial<WorklistCase> = {}): WorklistCase => ({
  caseId: 'a0000001-0000-4000-8000-000000000000',
  slaState: 'on_track',
  documentsMissing: 0,
  openTaskOverdueCount: 0,
  agentId: 'u-agent',
  coordinatorId: 'u-coord',
  ...over,
});
const draft = (over: Partial<WorklistDraft> = {}): WorklistDraft => ({
  id: 'd0000001-0000-4000-8000-000000000000',
  conversation_id: C1,
  status: 'pending',
  created_at: ago(1),
  inbox: null,
  ownerId: null,
  ...over,
});
const task = (over: Partial<WorklistHrTask> = {}): WorklistHrTask => ({
  status: 'open',
  due_at: ago(2),
  source_ref: `hr:${C1}:rule:event`,
  ...over,
});
const inputs = (over: Partial<WorklistInputs> = {}): WorklistInputs => ({
  hrConversations: [],
  hrTasks: [],
  cases: [],
  drafts: [],
  hrRules: [],
  ...over,
});
const ADMIN: WorklistScope = { userId: 'u-admin', role: 'admin' };
const one = (i: WorklistInputs) => rankWorklist(i, NOW, ADMIN)[0]!;

describe('worklist weights', () => {
  it('reuses the hire fast weights exactly and adds the 029c components', () => {
    for (const [k, v] of Object.entries(HIREFAST_WEIGHTS))
      expect(WORKLIST_WEIGHTS[k as keyof typeof WORKLIST_WEIGHTS]).toBe(v);
    expect(WORKLIST_WEIGHTS).toMatchObject({
      replyDue: 100,
      waitingOnThem: 10,
      urgent: 50,
      upset: 30,
      waitedCapHours: 72,
      taskOverdue: 20,
      stalled: 20,
      slaOverdue: 80,
      slaDueSoon: 40,
      docsMissing: 25,
      draftWaiting: 60,
      draftOld: 10,
      draftOldHours: 24,
    });
  });

  it('HR chat: reply due 100, waiting 10, urgent +50, upset +30, hours capped at 72', () => {
    expect(one(inputs({ hrConversations: [conv()] })).score).toBe(10);
    expect(
      one(
        inputs({
          hrConversations: [
            conv({ reply_state: 'reply_due', last_inbound_at: ago(5) }),
          ],
        })
      )
    ).toMatchObject({ score: 105, reasons: ['reply_due'] });
    expect(
      one(
        inputs({
          hrConversations: [
            conv({
              reply_state: 'new',
              urgent: true,
              upset: true,
              last_inbound_at: ago(200),
            }),
          ],
        })
      )
    ).toMatchObject({
      score: 100 + 50 + 30 + 72,
      reasons: ['reply_due', 'urgent', 'upset', 'waiting_long'],
    });
  });

  it('stage weights 0 / 5 / 10 / 15 with late_stage from 10', () => {
    const s = (stage_key: WorklistHrConversation['stage_key']) =>
      one(inputs({ hrConversations: [conv({ stage_key })] }));
    expect(
      (
        [
          'cv_review',
          'ai_interview',
          'hr_interview',
          'manager_interview',
        ] as const
      ).map((k) => s(k).score)
    ).toEqual([10, 15, 20, 25]);
    expect(s('ai_interview').reasons).toEqual([]);
    expect(s('hr_interview').reasons).toEqual(['late_stage']);
  });

  it('overdue HR task +20 and stalled +20 (enabled no_activity_recruiter rule)', () => {
    const rules = [
      { key: 'no_activity_recruiter' as const, enabled: true, after_hours: 48 },
    ];
    const old = conv({ last_outbound_at: ago(60), created_at: ago(70) });
    expect(
      one(inputs({ hrConversations: [old], hrTasks: [task()], hrRules: rules }))
    ).toMatchObject({ score: 50, reasons: ['task_overdue', 'stalled'] });
    const notYet = one(
      inputs({
        hrConversations: [old],
        hrTasks: [task({ due_at: new Date(NOW + 3_600_000).toISOString() })],
      })
    );
    expect(notYet.score).toBe(10);
    // The recruiter rule never stalls a department chat.
    const dept = conv({ ...old, inbox: 'dept' });
    expect(one(inputs({ hrConversations: [dept], hrRules: rules })).score).toBe(
      10
    );
  });

  it('case: SLA overdue +80, due soon +40, docs missing +25, overdue task +20; nothing due: not listed', () => {
    expect(
      one(
        inputs({
          cases: [
            kase({
              slaState: 'overdue',
              documentsMissing: 2,
              openTaskOverdueCount: 1,
            }),
          ],
        })
      )
    ).toMatchObject({
      kind: 'case',
      score: 125,
      reasons: ['sla_overdue', 'docs_missing', 'task_overdue'],
    });
    expect(
      one(inputs({ cases: [kase({ slaState: 'due_soon' })] }))
    ).toMatchObject({
      score: 40,
      reasons: ['sla_due_soon'],
    });
    expect(rankWorklist(inputs({ cases: [kase()] }), NOW, ADMIN)).toEqual([]);
  });

  it('agent draft pending +60, +10 when older than 24 h; decided drafts are not listed', () => {
    expect(one(inputs({ drafts: [draft()] }))).toMatchObject({
      kind: 'agent_draft',
      score: 60,
      reasons: ['draft_waiting'],
    });
    expect(
      one(inputs({ drafts: [draft({ created_at: ago(25) })] }))
    ).toMatchObject({
      score: 70,
      reasons: ['draft_waiting', 'draft_old'],
    });
    expect(
      rankWorklist(
        inputs({ drafts: [draft({ status: 'approved' })] }),
        NOW,
        ADMIN
      )
    ).toEqual([]);
  });
});

describe('worklist ordering and scoping', () => {
  const mixed = inputs({
    hrConversations: [
      conv({
        conversation_id: 'c-b',
        reply_state: 'reply_due',
        last_inbound_at: ago(1),
        ownerId: 'u-agent',
      }),
      conv({
        conversation_id: 'c-a',
        reply_state: 'reply_due',
        last_inbound_at: ago(1),
        ownerId: 'u-other',
      }),
      conv({
        conversation_id: 'c-closed',
        reply_state: 'reply_due',
        closed_at: ago(1),
        outcome: 'hired',
      } as Partial<WorklistHrConversation>),
    ],
    cases: [
      kase({
        caseId: 'k-1',
        slaState: 'overdue',
        agentId: 'u-other',
        coordinatorId: 'u-agent',
      }),
    ],
    drafts: [draft({ id: 'd-1', conversation_id: 'c-a' })],
  });

  it('sorts by score desc, ties by id; closed chats dropped', () => {
    expect(rankWorklist(mixed, NOW, ADMIN).map((i) => [i.id, i.score])).toEqual(
      [
        ['c-a', 101],
        ['c-b', 101],
        ['k-1', 80],
        ['d-1', 60],
      ]
    );
    const shuffled = {
      ...mixed,
      hrConversations: [...mixed.hrConversations].reverse(),
    };
    expect(rankWorklist(shuffled, NOW, ADMIN)).toEqual(
      rankWorklist(mixed, NOW, ADMIN)
    );
  });

  it('modes follow roles.ts: agent / viewer own, team leader and up all, bank guest nothing', () => {
    expect((['agent', 'viewer'] as const).map(worklistMode)).toEqual([
      'own',
      'own',
    ]);
    expect(
      (['team_leader', 'admin', 'owner'] as const).map(worklistMode)
    ).toEqual(['all', 'all', 'all']);
    expect(worklistMode('bank_guest')).toBe('none');
    expect(worklistMode(null)).toBe('none');
    expect(
      rankWorklist(mixed, NOW, { userId: 'u-agent', role: 'bank_guest' })
    ).toEqual([]);
  });

  it('a member sees only items assigned to them (HR owner, case agent or coordinator, draft via its chat)', () => {
    expect(
      rankWorklist(mixed, NOW, { userId: 'u-agent', role: 'agent' }).map(
        (i) => i.id
      )
    ).toEqual(['c-b', 'k-1']);
    expect(
      rankWorklist(mixed, NOW, {
        userId: 'u-agent',
        role: 'agent',
        assignedTo: 'u-other',
      }).map((i) => i.id)
    ).toEqual(['c-b', 'k-1']);
    expect(
      rankWorklist(mixed, NOW, { userId: 'u-other', role: 'viewer' }).map(
        (i) => i.id
      )
    ).toEqual(['c-a', 'k-1', 'd-1']);
  });

  it('leads see all, narrowed by the assigned-to filter', () => {
    expect(
      rankWorklist(mixed, NOW, { userId: 'u-lead', role: 'team_leader' })
    ).toHaveLength(4);
    expect(
      rankWorklist(mixed, NOW, {
        userId: 'u-lead',
        role: 'team_leader',
        assignedTo: 'u-other',
      }).map((i) => i.id)
    ).toEqual(['c-a', 'k-1', 'd-1']);
  });

  it('items carry kind, id, ref, href to an existing screen, score and reasons; no bodies or names', () => {
    const items = rankWorklist(mixed, NOW, ADMIN);
    expect(items[0]).toMatchObject({
      kind: 'hr_conversation',
      id: 'c-a',
      ref: 'c-a',
      href: '/hr/recruiter?c=c-a',
    });
    expect(items.find((i) => i.kind === 'case')).toMatchObject({
      href: '/cases/k-1',
    });
    expect(items.find((i) => i.kind === 'agent_draft')).toMatchObject({
      href: '/hr/recruiter?c=c-a',
      assignees: ['u-other'],
    });
    const deptDraft = rankWorklist(
      inputs({ drafts: [draft({ inbox: 'dept', ownerId: 'u-x' })] }),
      NOW,
      ADMIN
    )[0]!;
    expect(deptDraft).toMatchObject({
      ref: 'd0000001',
      href: `/hr/department?c=${C1}`,
      assignees: ['u-x'],
    });
    for (const i of [...items, deptDraft])
      expect(Object.keys(i).sort()).toEqual([
        'assignees',
        'href',
        'id',
        'kind',
        'reasons',
        'ref',
        'score',
      ]);
    expect(worklistReasonLabel('sla_overdue')).toBe(
      'Worklist.reason.sla_overdue'
    );
    expect(worklistReasonLabel('reply_due')).toBe(
      'Hr.hireFast.reason.reply_due'
    );
  });

  it('labels are i18n keys only: every 029c reason under Worklist.reason, kinds under Worklist.kind', () => {
    expect(WORKLIST_OWN_REASONS.map(worklistReasonLabel)).toEqual(
      WORKLIST_OWN_REASONS.map((c) => `Worklist.reason.${c}`)
    );
    expect(worklistKindKey('agent_draft')).toBe('Worklist.kind.agent_draft');
  });
});
