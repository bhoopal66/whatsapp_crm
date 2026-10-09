import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import type { AiConfig } from './types';

interface AiConfigRow {
  provider: 'openai' | 'anthropic';
  model: string;
  api_key: string;
  system_prompt: string | null;
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_campaign_only: boolean;
  auto_reply_max_per_conversation: number;
  handoff_agent_id: string | null;
  embeddings_api_key: string | null;
  escalation_keywords: string[] | null;
  retrieval_min_score: number | null;
  strict_grounding: boolean | null;
  handoff_message: string | null;
  model_small: string | null;
  model_large: string | null;
  model_routing: boolean | null;
  pause_on_agent_reply: boolean | null;
  auto_resume_minutes: number | null;
  guardrail_retry: boolean | null;
  reply_on_all_numbers?: boolean | null;
}

/** A tier model id, or null when unset/blank ("use `model`"). */
function tierModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const CONFIG_COLUMNS_078 =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_campaign_only, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, escalation_keywords, retrieval_min_score, strict_grounding, handoff_message, model_small, model_large, model_routing, pause_on_agent_reply, auto_resume_minutes, guardrail_retry';
const CONFIG_COLUMNS = `${CONFIG_COLUMNS_078}, reply_on_all_numbers`;

/**
 * True when the read failed only because migration 079's column is not
 * there yet (Postgres 42703, or PGRST204 from the schema cache). The
 * bot then loads as before 079 — answering on its routed number —
 * rather than going silent on every inbound until the migration lands.
 */
function missingAllNumbersColumn(
  error: { code?: string; message?: string } | null
): boolean {
  return (
    !!error &&
    (error.code === '42703' || error.code === 'PGRST204') &&
    (error.message ?? '').includes('reply_on_all_numbers')
  );
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {}
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const read = (columns: string) =>
    db
      .from('ai_configs')
      .select(columns)
      .eq('account_id', accountId)
      .maybeSingle();
  let { data, error } = await read(CONFIG_COLUMNS);
  if (missingAllNumbersColumn(error)) {
    ({ data, error } = await read(CONFIG_COLUMNS_078));
  }

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as AiConfigRow;
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null;
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null;

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null;
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key);
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`
      );
      embeddingsApiKey = null;
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyCampaignOnly: row.auto_reply_campaign_only === true,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    // Gate columns (migration 052). Each tolerates the column missing
    // on an older deployment by falling back to "gate off".
    escalationKeywords: Array.isArray(row.escalation_keywords)
      ? row.escalation_keywords.filter(
          (k): k is string => typeof k === 'string'
        )
      : [],
    retrievalMinScore:
      typeof row.retrieval_min_score === 'number' &&
      Number.isFinite(row.retrieval_min_score)
        ? row.retrieval_min_score
        : null,
    strictGrounding: row.strict_grounding === true,
    handoffMessage:
      typeof row.handoff_message === 'string' && row.handoff_message.trim()
        ? row.handoff_message.trim()
        : null,
    // AI agent v2 (migration 077). Absent columns (a pre-077 database)
    // read as: routing off, no tiers, pause on, no auto-resume, retry on.
    modelSmall: tierModel(row.model_small),
    modelLarge: tierModel(row.model_large),
    modelRouting: row.model_routing === true,
    pauseOnAgentReply: row.pause_on_agent_reply !== false,
    autoResumeMinutes:
      typeof row.auto_resume_minutes === 'number' &&
      Number.isInteger(row.auto_resume_minutes)
        ? row.auto_resume_minutes
        : null,
    guardrailRetry: row.guardrail_retry !== false,
    // Migration 079; absent (a pre-079 database) = the routed number only.
    replyOnAllNumbers: row.reply_on_all_numbers === true,
  };
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false };
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`
    );
    return { key: null, corrupt: true };
  }
}
