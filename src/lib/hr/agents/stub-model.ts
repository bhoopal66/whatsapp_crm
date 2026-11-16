/** Recruiter agents (package 024a) stub adapters: a deterministic keyword model (no API key) and a fixed clock, for tests. */
import type { ClockPort, ModelInput, ModelOutput, ModelPort } from './ports';
import type { AgentLang, Intent } from './types';

const CLASSIFY: Array<[Intent, RegExp, string[]]> = [
  [
    'schedule_interview',
    /\b(interview|schedule|reschedule|slot|available|availability|meeting)\b/i,
    ['\u0645\u0642\u0627\u0628\u0644\u0629', '\u0645\u0648\u0639\u062F'],
  ],
  [
    'cv_received',
    /\b(cv|resume|r\u00E9sum\u00E9|attached|attachment)\b/i,
    [
      '\u0633\u064A\u0631\u0629',
      '\u0627\u0644\u0633\u064A\u0631\u0629 \u0627\u0644\u0630\u0627\u062A\u064A\u0629',
      '\u0645\u0631\u0641\u0642',
    ],
  ],
  [
    'question_role',
    /\b(role|position|job|responsibilit\w*|duties|vacancy)\b/i,
    [
      '\u0648\u0638\u064A\u0641\u0629',
      '\u0627\u0644\u0648\u0638\u064A\u0641\u0629',
      '\u0627\u0644\u0645\u0633\u0624\u0648\u0644\u064A\u0627\u062A',
    ],
  ],
  [
    'question_process',
    /\b(process|next step|status|how long|stage|update)\b/i,
    [
      '\u0627\u0644\u0645\u0631\u062D\u0644\u0629',
      '\u0627\u0644\u0625\u062C\u0631\u0627\u0621\u0627\u062A',
      '\u0627\u0644\u062E\u0637\u0648\u0629',
    ],
  ],
];

export function stubIntent(text: string): Intent {
  for (const [intent, en, ar] of CLASSIFY)
    if (en.test(text) || ar.some((w) => text.includes(w))) return intent;
  return 'other';
}

const CANNED: Record<string, Record<AgentLang, string>> = {
  cv_screening: {
    en: 'Thank you for sending your CV. Our team is reviewing it and will update you on the next step.',
    ar: '\u0634\u0643\u0631\u0627 \u0644\u0625\u0631\u0633\u0627\u0644 \u0633\u064A\u0631\u062A\u0643 \u0627\u0644\u0630\u0627\u062A\u064A\u0629. \u0641\u0631\u064A\u0642\u0646\u0627 \u064A\u0631\u0627\u062C\u0639\u0647\u0627 \u0648\u0633\u0646\u0628\u0644\u063A\u0643 \u0628\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062A\u0627\u0644\u064A\u0629.',
  },
  scheduling_none: {
    en: 'Thank you. A recruiter will share the available interview times with you shortly.',
    ar: '\u0634\u0643\u0631\u0627 \u0644\u0643. \u0633\u064A\u0634\u0627\u0631\u0643 \u0645\u0639\u0643 \u0623\u062D\u062F \u0645\u0633\u0624\u0648\u0644\u064A \u0627\u0644\u062A\u0648\u0638\u064A\u0641 \u0623\u0648\u0642\u0627\u062A \u0627\u0644\u0645\u0642\u0627\u0628\u0644\u0629 \u0627\u0644\u0645\u062A\u0627\u062D\u0629 \u0642\u0631\u064A\u0628\u0627.',
  },
  scheduling_slots: {
    en: 'Thank you. These interview times are available: {slots}. Please reply with the one that suits you.',
    ar: '\u0634\u0643\u0631\u0627 \u0644\u0643. \u0623\u0648\u0642\u0627\u062A \u0627\u0644\u0645\u0642\u0627\u0628\u0644\u0629 \u0627\u0644\u0645\u062A\u0627\u062D\u0629: {slots}. \u064A\u0631\u062C\u0649 \u0627\u0644\u0631\u062F \u0628\u0627\u0644\u0648\u0642\u062A \u0627\u0644\u0645\u0646\u0627\u0633\u0628 \u0644\u0643.',
  },
  question_role: {
    en: 'Thank you for your question about the role. A recruiter will share the role details with you.',
    ar: '\u0634\u0643\u0631\u0627 \u0644\u0633\u0624\u0627\u0644\u0643 \u0639\u0646 \u0627\u0644\u0648\u0638\u064A\u0641\u0629. \u0633\u064A\u0634\u0627\u0631\u0643 \u0645\u0639\u0643 \u0623\u062D\u062F \u0645\u0633\u0624\u0648\u0644\u064A \u0627\u0644\u062A\u0648\u0638\u064A\u0641 \u062A\u0641\u0627\u0635\u064A\u0644\u0647\u0627.',
  },
  question_process: {
    en: 'Our process has four steps: CV review, AI interview, HR interview and manager interview. We will update you at each step.',
    ar: '\u062A\u062A\u0643\u0648\u0646 \u0625\u062C\u0631\u0627\u0621\u0627\u062A\u0646\u0627 \u0645\u0646 \u0623\u0631\u0628\u0639 \u062E\u0637\u0648\u0627\u062A: \u0645\u0631\u0627\u062C\u0639\u0629 \u0627\u0644\u0633\u064A\u0631\u0629 \u0627\u0644\u0630\u0627\u062A\u064A\u0629\u060C \u0645\u0642\u0627\u0628\u0644\u0629 \u0622\u0644\u064A\u0629\u060C \u0645\u0642\u0627\u0628\u0644\u0629 \u0627\u0644\u0645\u0648\u0627\u0631\u062F \u0627\u0644\u0628\u0634\u0631\u064A\u0629\u060C \u062B\u0645 \u0645\u0642\u0627\u0628\u0644\u0629 \u0627\u0644\u0645\u062F\u064A\u0631. \u0633\u0646\u0628\u0644\u063A\u0643 \u0639\u0646\u062F \u0643\u0644 \u062E\u0637\u0648\u0629.',
  },
};

/** Deterministic model: classify by keywords; draft from canned text per agent and language. */
export class StubModel implements ModelPort {
  calls: ModelInput[] = [];
  async complete(input: ModelInput): Promise<ModelOutput> {
    this.calls.push(input);
    if (input.task === 'classify')
      return { text: '', intent: stubIntent(input.inboundText) };
    const lang = input.lang;
    if (input.agent === 'scheduling') {
      const slots = input.slots ?? [];
      if (slots.length === 0) return { text: CANNED.scheduling_none![lang] };
      return {
        text: CANNED.scheduling_slots![lang].replace(
          '{slots}',
          slots.join(', ')
        ),
      };
    }
    if (input.agent === 'candidate_faq')
      return {
        text: CANNED[
          input.intent === 'question_process'
            ? 'question_process'
            : 'question_role'
        ]![lang],
      };
    if (input.agent === 'cv_screening')
      return { text: CANNED.cv_screening![lang] };
    return { text: '' };
  }
}

export class FixedClock implements ClockPort {
  constructor(private at: Date) {}
  now(): Date {
    return new Date(this.at.getTime());
  }
}

export const systemClock: ClockPort = { now: () => new Date() };
