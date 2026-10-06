/** Shared types and helpers for the Phase 3 evaluation tools. */
import { readFileSync } from 'node:fs';

export interface TriageLabel {
  id: string;
  lang?: string;
  message: string;
  /** The host's stage: open_conversation | campaign_reply | guided_flow. */
  journey_stage?: string;
  /** Earlier turns, as production sends them (the latest 6). */
  recent_turns?: { from: 'customer' | 'taamul'; text: string }[];
  expected: { intent: string; opt_out: boolean; wants_human: boolean };
}
export interface GuardrailLabel {
  id: string;
  customer_message: string;
  bot_reply: string;
  evidence: { id: string; text: string }[];
  /** The business's own sources the bot was also given (instructions,
   *  campaign message, flow step), as production passes them. */
  context?: string[];
  expected_outcome: 'send' | 'hold' | 'block';
  seeded_dangerous?: boolean;
}
export interface AnswerRow {
  id: string;
  check: 'triage' | 'guardrail';
  lang: string;
  ok: boolean;
  errorCode: string | null;
  model: string | null;
  qs: string;
  simulated: boolean;
  answers: Record<string, unknown> | null;
  input_tokens: number | null;
  latency_ms: number;
  label: TriageLabel | GuardrailLabel;
}

export const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as T);
