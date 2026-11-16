/**
 * Recruiter agent ports (package 024a). ModelPort is the single port for
 * any LLM. There is deliberately NO send port: this module has no way to
 * deliver a message to a candidate.
 */
import type { HrStage } from '@/lib/hr/types';
import type { AgentKind, AgentLang, HistoryItem, Intent } from './types';

export interface ModelInput {
  task: 'classify' | 'draft';
  agent: AgentKind;
  lang: AgentLang;
  stage: HrStage | null;
  inboundText: string;
  history: HistoryItem[];
  /** Intent already decided (draft task). */
  intent?: Intent;
  slots?: string[];
}

export interface ModelOutput {
  text: string;
  /** classify: the intent; draft: set only when the specialist should re-route to another intent. */
  intent?: Intent;
}

export interface ModelPort {
  complete(input: ModelInput): Promise<ModelOutput>;
}

export interface ClockPort {
  now(): Date;
}

export interface AgentDeps {
  model: ModelPort;
  clock: ClockPort;
}
