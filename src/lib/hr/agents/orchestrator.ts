/**
 * 024a orchestrator: classify an inbound candidate message, apply the guardrails, route to one specialist and
 * return at most one DRAFT. Never sends. Bounded to MAX_HOPS agent hops; any throw fails closed (handoff 'error',
 * no draft). Every hop is recorded in the trace.
 */
import type { AgentDeps } from './ports';
import {
  INTENTS,
  type AgentKind,
  type HandoffReason,
  type Intent,
  type RunInput,
  type RunResult,
  type TraceHop,
} from './types';
import type { HrStage } from '@/lib/hr/types';
import {
  MAX_HOPS,
  capReached,
  detectLang,
  draftViolation,
  insideWindow,
  preCheck,
  withDisclosure,
} from './guardrails';
import type { Specialist } from './specialists/common';
import { cvScreening } from './specialists/cv-screening';
import { scheduling } from './specialists/scheduling';
import { candidateFaq } from './specialists/candidate-faq';
import { escalation } from './specialists/escalation';

const SPECIALISTS: Record<Exclude<AgentKind, 'orchestrator'>, Specialist> = {
  cv_screening: cvScreening,
  scheduling,
  candidate_faq: candidateFaq,
  escalation: (input) => escalation(input),
};

const EARLY: readonly (HrStage | null)[] = ['cv_review', 'ai_interview'];
const LATE: readonly (HrStage | null)[] = ['hr_interview', 'manager_interview'];

/** Intent + stage -> specialist; null = no specialist fits (human triage). */
export function route(
  intent: Intent,
  stage: HrStage | null
): Exclude<AgentKind, 'orchestrator'> | null {
  switch (intent) {
    case 'salary_offer_visa':
    case 'upset':
      return 'escalation';
    case 'schedule_interview':
      return 'scheduling';
    case 'question_role':
    case 'question_process':
      return 'candidate_faq';
    case 'cv_received':
      return EARLY.includes(stage) ? 'cv_screening' : null;
    case 'other':
      if (EARLY.includes(stage)) return 'cv_screening';
      if (LATE.includes(stage)) return 'scheduling';
      return null;
    default:
      return null;
  }
}

function asIntent(v: unknown): Intent {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v)
    ? (v as Intent)
    : 'other';
}

export async function run(
  input: RunInput,
  deps: AgentDeps
): Promise<RunResult> {
  const trace: TraceHop[] = [];
  let intent: Intent = 'other';
  let agent: AgentKind = 'orchestrator';
  const hop = (a: AgentKind, reason: string): void => {
    if (trace.length >= MAX_HOPS) throw new HopBoundError();
    trace.push({ agent: a, reason, startedAt: deps.clock.now().toISOString() });
    agent = a;
  };
  try {
    hop('orchestrator', 'classify');
    const lang = detectLang(input.inboundText);
    if (input.optedOut)
      return {
        intent: 'opt_out',
        agent,
        trace: note(trace, 'contact opted out: no draft'),
      };

    let handoff: HandoffReason | undefined;
    let flag: RunResult['flag'];
    const pre = preCheck(input.inboundText);
    if (pre) {
      intent = pre.intent;
      handoff = pre.handoff;
      flag = pre.flag;
      note(trace, pre.reason);
      if (pre.optOut) return { intent, agent, optOut: true, trace };
    } else {
      const c = await deps.model.complete({
        task: 'classify',
        agent: 'orchestrator',
        lang,
        stage: input.stage,
        inboundText: input.inboundText,
        history: input.history,
      });
      intent = asIntent(c.intent);
      note(trace, `model intent ${intent}`);
      if (intent === 'opt_out')
        return { intent, agent, handoff: 'model', trace };
      if (intent === 'upset') {
        flag = 'urgent';
        handoff = 'model';
      }
      if (intent === 'salary_offer_visa') handoff = 'model';
    }
    const base = (): RunResult => ({
      intent,
      agent,
      trace,
      ...(handoff ? { handoff } : {}),
      ...(flag ? { flag } : {}),
    });

    const cap = capReached(
      input.pendingDrafts ?? 0,
      input.draftsToday ?? 0,
      input.settings.replyCapPerDay
    );
    if (cap) {
      note(trace, `cap: ${cap}`);
      return { ...base(), handoff: 'cap' };
    }
    if (!input.settings.enabled.orchestrator) {
      note(trace, 'orchestrator disabled');
      return { ...base(), handoff: handoff ?? 'triage' };
    }

    for (;;) {
      const target = route(intent, input.stage);
      if (!target) {
        note(
          trace,
          `no specialist for ${intent} at ${input.stage ?? 'no stage'}`
        );
        return { ...base(), handoff: handoff ?? 'triage' };
      }
      if (!input.settings.enabled[target]) {
        note(trace, `${target} disabled`);
        return { ...base(), handoff: handoff ?? 'triage' };
      }
      hop(target, `intent ${intent}`);
      if (
        input.windowApplies &&
        !insideWindow(input.lastInboundAt, deps.clock.now())
      ) {
        note(trace, 'outside 24h window: template required');
        return {
          ...base(),
          draft: { agentKind: target, body: '', requiresTemplate: true, lang },
        };
      }
      const slots = input.slots ?? [];
      const out = await SPECIALISTS[target](
        {
          intent,
          lang,
          stage: input.stage,
          inboundText: input.inboundText,
          history: input.history,
          slots,
        },
        deps.model
      );
      if (out.reroute) {
        const next = asIntent(out.reroute);
        note(trace, `reroute to ${next}`);
        if (next === 'opt_out') return { ...base(), handoff: 'model' };
        if (next === 'salary_offer_visa' || next === 'upset')
          handoff = handoff ?? 'model';
        if (next === 'upset') flag = 'urgent';
        intent = next;
        continue;
      }
      if (!out.text.trim()) {
        note(trace, 'empty draft');
        return { ...base(), handoff: 'no_knowledge' };
      }
      const violation = draftViolation(out.text, slots);
      if (violation) {
        note(trace, `guardrail: ${violation}`);
        return { ...base(), handoff: 'guardrail' };
      }
      return {
        ...base(),
        draft: {
          agentKind: target,
          body: withDisclosure(out.text, lang),
          requiresTemplate: false,
          lang,
        },
      };
    }
  } catch (e) {
    const reason: HandoffReason =
      e instanceof HopBoundError ? 'model' : 'error';
    const why =
      e instanceof HopBoundError ? 'hop bound reached' : 'error: failed closed';
    if (trace.length === 0)
      trace.push({ agent, reason: why, startedAt: safeNow(deps) });
    else note(trace, why);
    return { intent, agent, handoff: reason, trace };
  }
}

class HopBoundError extends Error {
  constructor() {
    super('hop bound');
  }
}

/** Appends a reason to the current hop (no new hop). */
function note(trace: TraceHop[], reason: string): TraceHop[] {
  const last = trace[trace.length - 1];
  if (last) last.reason = `${last.reason}; ${reason}`;
  return trace;
}

function safeNow(deps: AgentDeps): string {
  try {
    return deps.clock.now().toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
