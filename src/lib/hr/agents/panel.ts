/**
 * What the HR panel's "Agent drafts" section offers (pure; the component in
 * `components/hr/hr-agent-drafts.tsx` only renders it). Message keys are
 * relative to the `Hr` namespace. Nothing here sends: an approved draft
 * is copied into the chat by a person.
 */
import type { HrErrorCode, HrRoles } from '@/lib/hr/types';

import type { HrAgentDraftRow } from './api';
import { isSensitive } from './guardrails';

/** Mirrors the route's limits (`app/api/hr/agents/run/route.ts`). */
export const MAX_SLOTS = 5;
export const SLOT_MAX_CHARS = 80;
/** Longest reject reason the panel accepts. */
export const REJECT_REASON_MAX = 500;

/** Who may draft, approve and reject: admins and the recruiter team. */
export function mayActOnDrafts(roles: HrRoles | null): boolean {
  return !!roles && (roles.admin || roles.recruiter !== null);
}

function isBlank(s: string | null | undefined): boolean {
  return !s || /^\s*$/.test(s);
}

export interface DraftActions {
  approve: boolean;
  /** Reject with an optional reason (a draft with a body). */
  reject: boolean;
  /** Reject a pending draft that has no body (nothing to edit or read). */
  dismiss: boolean;
  copy: boolean;
}

export function draftActions(
  draft: Pick<HrAgentDraftRow, 'status' | 'body' | 'requires_template'>,
  canAct: boolean
): DraftActions {
  const pending = canAct && draft.status === 'pending';
  const blank = isBlank(draft.body);
  return {
    approve: pending && !blank && !draft.requires_template,
    reject: pending && !blank,
    dismiss: pending && blank,
    copy: canAct && draft.status === 'approved' && !blank,
  };
}

/** "Draft a reply" is offered on an open chat to someone who may act. */
export function canRunAgents(
  canAct: boolean,
  closedAt: string | null
): boolean {
  return canAct && closedAt === null;
}

/** Every error code POST /api/hr/agents/run answers with. */
export const RUN_ERRORS = [
  'agents_off',
  'ai_off',
  'no_message',
  'closed',
  'opted_out',
  'cap',
  'limit',
  'not_recruiter',
  'not_found',
  'forbidden',
  'invalid',
  'failed',
] as const;

const RUN_ERROR_KEYS: Record<string, string> = {
  agents_off: 'agents.run.agentsOff',
  ai_off: 'agents.run.aiOff',
  no_message: 'agents.run.noMessage',
  closed: 'agents.run.closed',
  opted_out: 'agents.run.optedOut',
  cap: 'agents.run.cap',
  limit: 'agents.run.limit',
};

export interface RunMessage {
  key: string;
  tone: 'success' | 'info' | 'error';
}

/** The toast for a "Draft a reply" answer. */
export function runMessage(
  res: { data: { outcome: string } } | { error: string }
): RunMessage {
  if ('data' in res) {
    switch (res.data.outcome) {
      case 'drafted':
        return { key: 'agents.run.drafted', tone: 'success' };
      case 'handoff':
        return { key: 'agents.run.handoff', tone: 'info' };
      case 'opted_out':
        return { key: 'agents.run.optedOut', tone: 'info' };
      default:
        return { key: 'agents.run.failed', tone: 'error' };
    }
  }
  const key = RUN_ERROR_KEYS[res.error];
  if (!key) return { key: 'agents.run.failed', tone: 'error' };
  return {
    key,
    tone: res.error === 'opted_out' ? 'info' : 'error',
  };
}

/** `Hr.error.*` covers these; the rest get the drafts' own wording. */
const SHARED_ERRORS: readonly HrErrorCode[] = [
  'NOT_ALLOWED',
  'NOT_FOUND',
  'CLOSED',
  'INVALID',
];

/** The toast for a refused approve / reject. */
export function decideErrorKey(code: HrErrorCode): string {
  if (code === 'ALREADY_DECIDED') return 'agents.alreadyDecided';
  return SHARED_ERRORS.includes(code) ? `error.${code}` : 'error.UNKNOWN';
}

export type SlotParse =
  { slots: string[] } | { error: 'tooMany' | 'tooLong' | 'sensitive' };

/** "Interview times": comma separated, blanks dropped, ≤ 5 of ≤ 80 chars. */
export function parseSlots(input: string): SlotParse {
  const slots = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (slots.length > MAX_SLOTS) return { error: 'tooMany' };
  if (slots.some((s) => s.length > SLOT_MAX_CHARS)) return { error: 'tooLong' };
  // The route refuses these too: a slot is the one text a draft may
  // repeat, so it must not carry a salary / offer / visa promise.
  if (slots.some((s) => isSensitive(s))) return { error: 'sensitive' };
  return { slots };
}

export const agentKindKey = (k: string) => `agents.kind.${k}`;
export const intentKey = (i: string) => `agents.intent.${i}`;
export const handoffKey = (r: string) => `agents.handoff.${r}`;
export const draftStatusKey = (s: string) => `agents.status.${s}`;
