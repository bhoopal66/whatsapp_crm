/**
 * Recruiter agents (package 024a): types. Agents DRAFT replies for the
 * Recruiter HR inbox; nothing here sends anything. A human recruiter
 * approves every draft.
 */
import type { HrFlag, HrStage } from '@/lib/hr/types';

export const AGENT_KINDS = [
  'orchestrator',
  'cv_screening',
  'scheduling',
  'candidate_faq',
  'escalation',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const INTENTS = [
  'cv_received',
  'schedule_interview',
  'question_role',
  'question_process',
  'salary_offer_visa',
  'upset',
  'opt_out',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export const DRAFT_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Why a conversation goes to a human (mirrors the AI layer's handoff reasons). */
export const HANDOFF_REASONS = [
  'keyword',
  'no_knowledge',
  'model',
  'error',
  'cap',
  'triage',
  'guardrail',
  'kb',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export type AgentLang = 'en' | 'ar';

export interface HistoryItem {
  direction: 'in' | 'out';
  text: string;
  at: string;
}

export interface AgentSettings {
  /** Per-agent enable switch; a specialist that is not enabled hands off ('triage'). Default: all off. */
  enabled: Partial<Record<AgentKind, boolean>>;
  /** Drafts per conversation per day (default 5). */
  replyCapPerDay?: number;
}

export interface RunInput {
  accountId: string;
  conversationId: string;
  stage: HrStage | null;
  replyState: string;
  /**
   * Whether the WhatsApp 24 h customer-service window applies to the number
   * this chat is on. Only Meta Cloud API numbers have one; when false a
   * draft never requires a template.
   */
  windowApplies: boolean;
  /** ISO time of the candidate's last inbound message; null = never wrote (outside any window). */
  lastInboundAt: string | null;
  inboundText: string;
  history: HistoryItem[];
  settings: AgentSettings;
  /** Interview slots supplied by a recruiter; the only dates a draft may state. */
  slots?: string[];
  /** Pending drafts already on this conversation (max 3). */
  pendingDrafts?: number;
  /** Drafts already created today on this conversation (reply cap). */
  draftsToday?: number;
  /** The contact has opted out of agent drafts. */
  optedOut?: boolean;
}

export interface TraceHop {
  agent: AgentKind;
  reason: string;
  startedAt: string;
}

export interface AgentDraft {
  agentKind: AgentKind;
  /** Empty when requiresTemplate (outside the 24 h window a free-form reply is not allowed). */
  body: string;
  requiresTemplate: boolean;
  lang: AgentLang;
}

export interface RunResult {
  intent: Intent;
  agent: AgentKind;
  handoff?: HandoffReason;
  draft?: AgentDraft;
  /** Flag to raise through the existing HR flag hook (upset -> urgent). */
  flag?: HrFlag;
  /** Record an opt-out for the contact; no draft. */
  optOut?: boolean;
  trace: TraceHop[];
}
