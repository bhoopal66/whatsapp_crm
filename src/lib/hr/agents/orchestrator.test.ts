/** Recruiter agents core (package 024a): routing per intent and stage, every guardrail, the 24h window, caps, hop bound, fail closed, trace. */
import { describe, expect, it } from 'vitest';
import { run, route } from './orchestrator';
import { FixedClock, StubModel } from './stub-model';
import {
  AI_DISCLOSURE,
  AI_DISCLOSURE_AR,
  MAX_HOPS,
  draftViolation,
  isOptOut,
  isSensitive,
  isUpset,
  preCheck,
} from './guardrails';
import type { ModelInput, ModelOutput, ModelPort } from './ports';
import { AGENT_KINDS, type AgentKind, type RunInput } from './types';

const NOW = new Date('2026-11-14T10:00:00Z');
const clock = new FixedClock(NOW);
const ALL_ON = Object.fromEntries(AGENT_KINDS.map((k) => [k, true])) as Record<
  AgentKind,
  boolean
>;

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    accountId: 'acc',
    conversationId: 'c1',
    windowApplies: true,
    stage: 'cv_review',
    replyState: 'reply_due',
    lastInboundAt: '2026-11-14T09:00:00Z',
    inboundText: 'hello',
    history: [],
    settings: { enabled: ALL_ON },
    ...over,
  };
}

describe('024a routing', () => {
  it('routes by intent and stage', () => {
    expect(route('cv_received', 'cv_review')).toBe('cv_screening');
    expect(route('cv_received', 'ai_interview')).toBe('cv_screening');
    expect(route('cv_received', 'hr_interview')).toBeNull();
    expect(route('other', 'manager_interview')).toBe('scheduling');
    expect(route('other', null)).toBeNull();
    expect(route('schedule_interview', 'cv_review')).toBe('scheduling');
    expect(route('question_role', 'hr_interview')).toBe('candidate_faq');
    expect(route('question_process', 'cv_review')).toBe('candidate_faq');
    expect(route('salary_offer_visa', 'cv_review')).toBe('escalation');
    expect(route('upset', 'hr_interview')).toBe('escalation');
    expect(route('opt_out', 'cv_review')).toBeNull();
  });

  const cases: Array<[string, RunInput['stage'], string, AgentKind]> = [
    ['I attached my CV', 'cv_review', 'cv_received', 'cv_screening'],
    [
      'Can we schedule the interview?',
      'cv_review',
      'schedule_interview',
      'scheduling',
    ],
    [
      'What are the duties of the position?',
      'hr_interview',
      'question_role',
      'candidate_faq',
    ],
    [
      'What is the next step in the process?',
      'ai_interview',
      'question_process',
      'candidate_faq',
    ],
    ['ok thanks', 'manager_interview', 'other', 'scheduling'],
  ];
  for (const [text, stage, intent, agent] of cases) {
    it(`"${text}" at ${stage} -> ${intent} / ${agent}`, async () => {
      const r = await run(input({ inboundText: text, stage }), {
        model: new StubModel(),
        clock,
      });
      expect(r.intent).toBe(intent);
      expect(r.agent).toBe(agent);
      expect(r.handoff).toBeUndefined();
      expect(r.draft?.agentKind).toBe(agent);
      expect(r.draft?.requiresTemplate).toBe(false);
      expect(r.draft?.body.endsWith(AI_DISCLOSURE)).toBe(true);
      expect(r.trace.map((h) => h.agent)).toEqual(['orchestrator', agent]);
      expect(r.trace.every((h) => h.startedAt === NOW.toISOString())).toBe(
        true
      );
    });
  }

  it('CV at a late stage goes to triage, no draft', async () => {
    const r = await run(
      input({ inboundText: 'here is my resume', stage: 'hr_interview' }),
      { model: new StubModel(), clock }
    );
    expect(r).toMatchObject({ intent: 'cv_received', handoff: 'triage' });
    expect(r.draft).toBeUndefined();
  });

  it('Arabic draft carries the Arabic and English disclosure', async () => {
    const r = await run(
      input({
        inboundText:
          '\u0623\u0631\u0633\u0644\u062A \u0627\u0644\u0633\u064A\u0631\u0629 \u0627\u0644\u0630\u0627\u062A\u064A\u0629',
      }),
      { model: new StubModel(), clock }
    );
    expect(r.intent).toBe('cv_received');
    expect(r.draft?.lang).toBe('ar');
    expect(r.draft?.body).toContain(AI_DISCLOSURE_AR);
    expect(r.draft?.body.endsWith(AI_DISCLOSURE)).toBe(true);
  });
});

describe('024a guardrails', () => {
  it.each([
    'What is the salary?',
    'Did you send the offer letter?',
    'Who handles my visa?',
    'Please send the contract',
    'My lawyer will call',
    'I want to file a complaint',
    '\u0643\u0645 \u0627\u0644\u0631\u0627\u062A\u0628\u061F',
    '\u0645\u062A\u0649 \u0627\u0644\u062A\u0623\u0634\u064A\u0631\u0629\u061F',
  ])(
    'sensitive %s -> escalation holding draft, handoff keyword, no model draft',
    async (text) => {
      const model = new StubModel();
      const r = await run(input({ inboundText: text }), { model, clock });
      expect(r.intent).toBe('salary_offer_visa');
      expect(r.agent).toBe('escalation');
      expect(r.handoff).toBe('keyword');
      expect(model.calls).toHaveLength(0);
      expect(draftViolation(r.draft!.body)).toBeNull();
      expect(r.draft!.body).toMatch(
        /recruiter will review it and reply to you personally|\u0634\u062E\u0635\u064A\u0627/
      );
    }
  );

  it('sensitive keyword check covers salary, offer and visa', () => {
    for (const t of ['salary', 'offer', 'visa', 'contract'])
      expect(isSensitive(`about the ${t}`)).toBe(true);
    expect(preCheck('salary please')?.handoff).toBe('keyword');
  });

  it('upset -> urgent flag + triage handoff via escalation', async () => {
    const r = await run(
      input({ inboundText: 'This is unacceptable, I am angry' }),
      { model: new StubModel(), clock }
    );
    expect(r).toMatchObject({
      intent: 'upset',
      agent: 'escalation',
      handoff: 'triage',
      flag: 'urgent',
    });
    expect(isUpset('\u0623\u0646\u0627 \u063A\u0627\u0636\u0628')).toBe(true);
  });

  it.each([
    'STOP',
    'unsubscribe',
    'please opt out',
    '\u062A\u0648\u0642\u0641',
    '\u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643',
  ])('opt-out %s -> record opt-out, draft nothing', async (text) => {
    const model = new StubModel();
    const r = await run(input({ inboundText: text }), { model, clock });
    expect(r).toMatchObject({ intent: 'opt_out', optOut: true });
    expect(r.draft).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it('stop inside a sentence is not an opt-out', () => {
    expect(isOptOut('when does the process stop?')).toBe(false);
  });

  it('an opted-out contact gets nothing', async () => {
    const r = await run(
      input({ inboundText: 'I attached my CV', optedOut: true }),
      { model: new StubModel(), clock }
    );
    expect(r.draft).toBeUndefined();
    expect(r.intent).toBe('opt_out');
    expect(r.optOut).toBeUndefined();
  });

  it('model draft stating salary, offer, visa or a date is dropped (guardrail)', async () => {
    for (const text of [
      'Your salary will be 9000 AED.',
      'We will send the offer soon.',
      'Your visa is ready.',
      'See you tomorrow at 10:00.',
      'Interview on 2026-11-20.',
    ]) {
      const model: ModelPort = {
        complete: async (i: ModelInput): Promise<ModelOutput> =>
          i.task === 'classify'
            ? { text: '', intent: 'cv_received' }
            : { text },
      };
      const r = await run(input(), { model, clock });
      expect(r.handoff, text).toBe('guardrail');
      expect(r.draft).toBeUndefined();
    }
  });

  it('dates are allowed only from the supplied slots', async () => {
    const slots = ['Mon 17 Nov 10:00', 'Tue 18 Nov 14:30'];
    const r = await run(
      input({ inboundText: 'can we schedule the interview', slots }),
      { model: new StubModel(), clock }
    );
    expect(r.handoff).toBeUndefined();
    expect(r.draft?.body).toContain('Mon 17 Nov 10:00');
    expect(draftViolation('Come on Wed 19 Nov 09:00', slots)).toBe('date');
    expect(draftViolation('Come on Mon 17 Nov 10:00', slots)).toBeNull();
  });

  it('scheduling without slots states no date', async () => {
    const r = await run(
      input({ inboundText: 'when is my interview', stage: 'hr_interview' }),
      { model: new StubModel(), clock }
    );
    expect(r.draft && draftViolation(r.draft.body)).toBeNull();
  });
});

describe('024a window, caps, settings', () => {
  it('outside the 24h window: requires_template, empty body, no model draft', async () => {
    const model = new StubModel();
    const r = await run(
      input({
        inboundText: 'I attached my CV',
        lastInboundAt: '2026-11-13T09:59:59Z',
      }),
      { model, clock }
    );
    expect(r.draft).toMatchObject({
      requiresTemplate: true,
      body: '',
      agentKind: 'cv_screening',
    });
    expect(model.calls.filter((c) => c.task === 'draft')).toHaveLength(0);
    const never = await run(
      input({ inboundText: 'I attached my CV', lastInboundAt: null }),
      { model, clock }
    );
    expect(never.draft?.requiresTemplate).toBe(true);
    const inside = await run(
      input({
        inboundText: 'I attached my CV',
        lastInboundAt: '2026-11-13T10:00:01Z',
      }),
      { model, clock }
    );
    expect(inside.draft?.requiresTemplate).toBe(false);
  });

  it('the window is consulted only where it applies (Meta numbers)', async () => {
    const old = '2026-11-11T10:00:00Z'; // 3 days before NOW
    const linked = new StubModel();
    const off = await run(
      input({
        inboundText: 'I attached my CV',
        lastInboundAt: old,
        windowApplies: false,
      }),
      { model: linked, clock }
    );
    expect(off.handoff).toBeUndefined();
    expect(off.draft).toMatchObject({
      requiresTemplate: false,
      agentKind: 'cv_screening',
    });
    expect(off.draft?.body.endsWith(AI_DISCLOSURE)).toBe(true);
    expect(linked.calls.filter((c) => c.task === 'draft')).toHaveLength(1);
    const neverWrote = await run(
      input({
        inboundText: 'I attached my CV',
        lastInboundAt: null,
        windowApplies: false,
      }),
      { model: new StubModel(), clock }
    );
    expect(neverWrote.draft?.requiresTemplate).toBe(false);
    const meta = new StubModel();
    const on = await run(
      input({
        inboundText: 'I attached my CV',
        lastInboundAt: old,
        windowApplies: true,
      }),
      { model: meta, clock }
    );
    expect(on.draft).toMatchObject({
      requiresTemplate: true,
      body: '',
      agentKind: 'cv_screening',
    });
    expect(meta.calls.filter((c) => c.task === 'draft')).toHaveLength(0);
  });

  it('max 3 pending drafts per conversation', async () => {
    const r = await run(
      input({ inboundText: 'I attached my CV', pendingDrafts: 3 }),
      { model: new StubModel(), clock }
    );
    expect(r).toMatchObject({ handoff: 'cap' });
    expect(r.draft).toBeUndefined();
    const ok = await run(
      input({ inboundText: 'I attached my CV', pendingDrafts: 2 }),
      { model: new StubModel(), clock }
    );
    expect(ok.draft).toBeDefined();
  });

  it('reply cap per day (default 5, configurable)', async () => {
    expect(
      (
        await run(input({ inboundText: 'my CV', draftsToday: 5 }), {
          model: new StubModel(),
          clock,
        })
      ).handoff
    ).toBe('cap');
    expect(
      (
        await run(input({ inboundText: 'my CV', draftsToday: 4 }), {
          model: new StubModel(),
          clock,
        })
      ).draft
    ).toBeDefined();
    const s = { enabled: ALL_ON, replyCapPerDay: 2 };
    expect(
      (
        await run(
          input({ inboundText: 'my CV', draftsToday: 2, settings: s }),
          { model: new StubModel(), clock }
        )
      ).handoff
    ).toBe('cap');
  });

  it('disabled agents hand off to triage; default settings draft nothing', async () => {
    const r = await run(
      input({ inboundText: 'my CV', settings: { enabled: {} } }),
      { model: new StubModel(), clock }
    );
    expect(r).toMatchObject({ handoff: 'triage' });
    expect(r.draft).toBeUndefined();
    const r2 = await run(
      input({
        inboundText: 'my CV',
        settings: { enabled: { orchestrator: true } },
      }),
      { model: new StubModel(), clock }
    );
    expect(r2.handoff).toBe('triage');
    expect(r2.trace[0]!.reason).toContain('cv_screening disabled');
  });

  it('empty model text -> no_knowledge', async () => {
    const model: ModelPort = {
      complete: async (i) =>
        i.task === 'classify'
          ? { text: '', intent: 'question_role' }
          : { text: '  ' },
    };
    const r = await run(input({ inboundText: 'x' }), { model, clock });
    expect(r).toMatchObject({
      handoff: 'no_knowledge',
      agent: 'candidate_faq',
    });
  });
});

describe('024a hop bound and fail closed', () => {
  it(`bounded to ${MAX_HOPS} hops: a model that keeps re-routing hands off, no draft`, async () => {
    const model: ModelPort = {
      complete: async (i) =>
        i.task === 'classify'
          ? { text: '', intent: 'schedule_interview' }
          : {
              text: 'x',
              intent:
                i.agent === 'scheduling'
                  ? 'question_role'
                  : 'schedule_interview',
            },
    };
    const r = await run(input({ inboundText: 'x' }), { model, clock });
    expect(r.handoff).toBe('model');
    expect(r.draft).toBeUndefined();
    expect(r.trace).toHaveLength(MAX_HOPS);
    expect(r.trace.map((h) => h.agent)).toEqual([
      'orchestrator',
      'scheduling',
      'candidate_faq',
      'scheduling',
    ]);
    expect(r.trace[MAX_HOPS - 1]!.reason).toContain('hop bound reached');
  });

  it('a single re-route is followed and traced', async () => {
    const model: ModelPort = {
      complete: async (i) =>
        i.task === 'classify'
          ? { text: '', intent: 'question_role' }
          : i.agent === 'candidate_faq'
            ? { text: '', intent: 'salary_offer_visa' }
            : { text: 'never' },
    };
    const r = await run(input({ inboundText: 'x' }), { model, clock });
    expect(r.trace.map((h) => h.agent)).toEqual([
      'orchestrator',
      'candidate_faq',
      'escalation',
    ]);
    expect(r).toMatchObject({ agent: 'escalation', handoff: 'model' });
    expect(r.draft?.body).toContain('reply to you personally');
  });

  it('any throw fails closed: handoff error, no draft', async () => {
    const boom: ModelPort = {
      complete: async () => {
        throw new Error('provider down');
      },
    };
    const r = await run(input({ inboundText: 'my CV' }), {
      model: boom,
      clock,
    });
    expect(r).toMatchObject({ handoff: 'error', agent: 'orchestrator' });
    expect(r.draft).toBeUndefined();
    expect(r.trace[0]!.reason).toContain('failed closed');
    const late: ModelPort = {
      complete: async (i) => {
        if (i.task === 'draft') throw new Error('x');
        return { text: '', intent: 'cv_received' };
      },
    };
    const r2 = await run(input({ inboundText: 'y' }), { model: late, clock });
    expect(r2).toMatchObject({ handoff: 'error', agent: 'cv_screening' });
    expect(r2.draft).toBeUndefined();
  });

  it('an unknown model intent is treated as other', async () => {
    const model: ModelPort = {
      complete: async (i) =>
        i.task === 'classify'
          ? { text: '', intent: 'hire_me' as never }
          : { text: 'Thanks, we are reviewing it.' },
    };
    const r = await run(input({ inboundText: 'x' }), { model, clock });
    expect(r.intent).toBe('other');
  });
});
