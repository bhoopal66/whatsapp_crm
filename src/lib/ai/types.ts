// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic';

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  /** Only answer conversations stamped by a campaign reply (migration 049). */
  autoReplyCampaignOnly: boolean;
  autoReplyMaxPerConversation: number;
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null;
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null;
  /**
   * Gate 1 (migration 052): words/phrases in the latest customer message
   * that hand the thread to a human before the model is called. Stored
   * lower-cased; see `lib/ai/escalation.ts` for the matching rules.
   */
  escalationKeywords: string[];
  /**
   * Gate 2: minimum cosine similarity (0–1) the best knowledge-base hit
   * must reach for the bot to answer; below it the bot hands off and
   * logs the question as a knowledge gap. Null = gate off.
   */
  retrievalMinScore: number | null;
  /**
   * Gate 3: when true the prompt makes the knowledge base the model's
   * ONLY source of facts (it may still greet / clarify), instead of the
   * default "prefer the excerpts".
   */
  strictGrounding: boolean;
  /**
   * Sent to the customer when a *gate* (keyword, no knowledge, provider
   * error) hands off — the model never saw the message, so without this
   * the customer hears nothing until an agent replies. Null = silent.
   */
  handoffMessage: string | null;
  /**
   * Cheap tier for greetings and small talk (migration 077). Null = use
   * `model`, which is the standard tier.
   */
  modelSmall: string | null;
  /**
   * Premium tier for complex, sensitive or high-value messages. Null =
   * use `model`.
   */
  modelLarge: string | null;
  /** Pick a tier per message; false = every message uses `model`. */
  modelRouting: boolean;
  /** A person's reply in a chat pauses the bot there (a DB trigger). */
  pauseOnAgentReply: boolean;
  /**
   * Minutes after the last agent reply before an `agent_reply` pause
   * lifts; null = never auto-resume.
   */
  autoResumeMinutes: number | null;
  /**
   * When TypeSafe holds a draft, rewrite it once with the large model
   * before a person has to review it.
   */
  guardrailRetry: boolean;
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null;
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
