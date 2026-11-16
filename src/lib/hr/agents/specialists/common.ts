/** 024a specialist contract: pure given a ModelPort; returns draft text or a re-route intent. */
import type { ModelPort } from '../ports';
import type { AgentLang, HistoryItem, Intent } from '../types';
import type { HrStage } from '@/lib/hr/types';

export interface SpecialistInput {
  intent: Intent;
  lang: AgentLang;
  stage: HrStage | null;
  inboundText: string;
  history: HistoryItem[];
  slots: string[];
}

export interface SpecialistResult {
  text: string;
  /** Set when the specialist asks the orchestrator to re-route (counts as a hop). */
  reroute?: Intent;
}

export type Specialist = (
  input: SpecialistInput,
  model: ModelPort
) => Promise<SpecialistResult>;
