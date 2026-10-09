import { AI_PROVIDER_DEFAULT_MODEL, AI_TIER_DEFAULT_MODELS } from './defaults';
import type { AiProvider } from './types';

/**
 * The AI Agents screen's config form (GET/POST /api/ai/config) as plain
 * values, so loading and the "unsaved changes" check are pure and
 * tested. Text fields hold what the inputs show; `aiConfigRequestBody`
 * turns them into the POST payload, and `buildAiSavePlan` decides what
 * Save sends.
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

/** The POST /api/ai/config body for the form's values. */
export function aiConfigRequestBody(values: AiConfigFormValues) {
  return {
    provider: values.provider,
    model: values.model.trim(),
    api_key: values.keyEdited ? values.apiKey.trim() : undefined,
    // undefined = leave unchanged; '' typed = null (clear); text = set.
    embeddings_api_key: values.embeddingsKeyEdited
      ? values.embeddingsKey.trim() || null
      : undefined,
    system_prompt: values.systemPrompt.trim() || null,
    is_active: values.isActive,
    auto_reply_enabled: values.autoReplyEnabled,
    auto_reply_campaign_only: values.autoReplyCampaignOnly,
    auto_reply_max_per_conversation: values.maxPerConversation,
    handoff_agent_id: values.handoffAgentId || null,
    escalation_keywords: values.escalationKeywords,
    retrieval_min_score:
      values.retrievalMinScore.trim() === ''
        ? null
        : Number(values.retrievalMinScore),
    strict_grounding: values.strictGrounding,
    handoff_message: values.handoffMessage.trim() || null,
    model_small: values.modelSmall.trim() || null,
    model_large: values.modelLarge.trim() || null,
    model_routing: values.modelRouting,
    pause_on_agent_reply: values.pauseOnAgentReply,
    reply_on_all_numbers: values.replyOnAllNumbers,
    auto_resume_minutes: values.autoResumeMinutes,
    guardrail_retry: values.guardrailRetry,
  };
}

/** What the server holds: the config and the explicit `ai_reply` route
 *  (null = no route row). */
export interface AiSavedState {
  configured: boolean;
  values: AiConfigFormValues;
  route: string | null;
}

/** What the form shows; `route` null = nothing picked yet. */
export interface AiCurrentState {
  values: AiConfigFormValues;
  route: string | null;
}

export interface AiSavePlan {
  /** The POST body, or null when the config needs no POST. */
  config: ReturnType<typeof aiConfigRequestBody> | null;
  /** The `ai_reply` route to PUT, or null for no PUT. */
  aiReplyRoute: string | null;
  dirty: boolean;
}

/**
 * What Save sends. "Only on" must end with an explicit `ai_reply` route:
 * without one, `resolveAiReplyChannel` answers on the thread's own number
 * whenever it shares the default number's provider, so with two Whapi
 * numbers the bot would answer on both. An account saved as "Only on"
 * with no route therefore shows the default number picked and is not
 * dirty, but its next save writes that number as the route.
 * "Every number" never touches the route.
 */
export function buildAiSavePlan(
  saved: AiSavedState,
  current: AiCurrentState,
  defaultRouteId: string | null
): AiSavePlan {
  const configChanged = isAiConfigFormDirty(saved.values, current.values);
  let aiReplyRoute: string | null = null;
  let routeChanged = false;
  if (!current.values.replyOnAllNumbers) {
    const pick = current.route ?? defaultRouteId;
    if (pick !== null && pick !== saved.route) aiReplyRoute = pick;
    routeChanged = pick !== (saved.route ?? defaultRouteId);
  }
  return {
    // A first save always POSTs; it is what creates the config.
    config:
      configChanged || !saved.configured
        ? aiConfigRequestBody(current.values)
        : null,
    aiReplyRoute,
    dirty: configChanged || routeChanged,
  };
}

/**
 * The saved state after a Save that ran `plan`: the config advances only
 * if its POST succeeded and the route only if its PUT did, so a failed
 * PUT stays dirty and the retry sends just the PUT.
 */
export function applyAiSaveResult(
  saved: AiSavedState,
  current: AiCurrentState,
  plan: AiSavePlan,
  outcome: { configSaved: boolean; routeSaved: boolean }
): AiSavedState {
  const configSaved = outcome.configSaved && plan.config !== null;
  const routeSaved = outcome.routeSaved && plan.aiReplyRoute !== null;
  return {
    configured: saved.configured || configSaved,
    values: configSaved ? current.values : saved.values,
    route: routeSaved ? plan.aiReplyRoute : saved.route,
  };
}
