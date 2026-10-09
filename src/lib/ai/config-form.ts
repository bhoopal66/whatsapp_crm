import { AI_PROVIDER_DEFAULT_MODEL, AI_TIER_DEFAULT_MODELS } from './defaults';
import type { AiProvider } from './types';

/**
 * The AI Agents screen's config form (GET/POST /api/ai/config) as plain
 * values, so loading and the "unsaved changes" check are pure and
 * tested. Text fields hold what the inputs show; `buildBody` in the
 * hook turns them into the POST payload.
 */
export const MASKED_KEY = '••••••••••••••••';

export interface AiConfigFormValues {
  provider: AiProvider;
  model: string;
  apiKey: string;
  keyEdited: boolean;
  embeddingsKey: string;
  embeddingsKeyEdited: boolean;
  systemPrompt: string;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyCampaignOnly: boolean;
  maxPerConversation: number;
  /** '' = unassigned (shared queue). */
  handoffAgentId: string;
  /** One keyword per line. */
  escalationKeywords: string;
  /** '' = off. */
  retrievalMinScore: string;
  strictGrounding: boolean;
  handoffMessage: string;
  modelSmall: string;
  modelLarge: string;
  modelRouting: boolean;
  pauseOnAgentReply: boolean;
  replyOnAllNumbers: boolean;
  autoResumeMinutes: number | null;
  guardrailRetry: boolean;
}

/** A blank, unconfigured form (also what Remove resets to). */
export function emptyAiConfigForm(
  provider: AiProvider = 'openai'
): AiConfigFormValues {
  return {
    provider,
    model: AI_PROVIDER_DEFAULT_MODEL[provider],
    apiKey: '',
    keyEdited: false,
    embeddingsKey: '',
    embeddingsKeyEdited: false,
    systemPrompt: '',
    isActive: false,
    autoReplyEnabled: false,
    autoReplyCampaignOnly: false,
    maxPerConversation: 3,
    handoffAgentId: '',
    escalationKeywords: '',
    retrievalMinScore: '',
    strictGrounding: false,
    handoffMessage: '',
    modelSmall: AI_TIER_DEFAULT_MODELS[provider].small,
    modelLarge: AI_TIER_DEFAULT_MODELS[provider].large,
    modelRouting: true,
    pauseOnAgentReply: true,
    replyOnAllNumbers: false,
    autoResumeMinutes: null,
    guardrailRetry: true,
  };
}

type Row = Record<string, unknown>;

/** The form for a configured GET /api/ai/config response. */
export function aiConfigFormFromResponse(data: Row): AiConfigFormValues {
  const provider: AiProvider =
    data.provider === 'anthropic' ? 'anthropic' : 'openai';
  const tier = AI_TIER_DEFAULT_MODELS[provider];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    provider,
    model: str(data.model),
    apiKey: data.has_key ? MASKED_KEY : '',
    keyEdited: false,
    embeddingsKey: data.has_embeddings_key ? MASKED_KEY : '',
    embeddingsKeyEdited: false,
    systemPrompt: str(data.system_prompt),
    isActive: data.is_active === true,
    autoReplyEnabled: data.auto_reply_enabled === true,
    autoReplyCampaignOnly: data.auto_reply_campaign_only === true,
    maxPerConversation:
      typeof data.auto_reply_max_per_conversation === 'number'
        ? data.auto_reply_max_per_conversation
        : 3,
    handoffAgentId: str(data.handoff_agent_id),
    escalationKeywords: Array.isArray(data.escalation_keywords)
      ? data.escalation_keywords.join('\n')
      : '',
    retrievalMinScore:
      typeof data.retrieval_min_score === 'number'
        ? String(data.retrieval_min_score)
        : '',
    strictGrounding: data.strict_grounding === true,
    handoffMessage: str(data.handoff_message),
    modelSmall: str(data.model_small) || tier.small,
    modelLarge: str(data.model_large) || tier.large,
    modelRouting: data.model_routing !== false,
    pauseOnAgentReply: data.pause_on_agent_reply !== false,
    replyOnAllNumbers: data.reply_on_all_numbers === true,
    autoResumeMinutes:
      typeof data.auto_resume_minutes === 'number'
        ? data.auto_resume_minutes
        : null,
    guardrailRetry: data.guardrail_retry !== false,
  };
}

const FIELDS = Object.keys(emptyAiConfigForm()) as (keyof AiConfigFormValues)[];

/** The fields that differ between what was loaded and what is shown. */
export function changedAiConfigFields(
  loaded: AiConfigFormValues,
  current: AiConfigFormValues
): (keyof AiConfigFormValues)[] {
  return FIELDS.filter((f) => !Object.is(loaded[f], current[f]));
}

/** Does the form hold edits that Save would send? */
export function isAiConfigFormDirty(
  loaded: AiConfigFormValues,
  current: AiConfigFormValues
): boolean {
  return changedAiConfigFields(loaded, current).length > 0;
}
