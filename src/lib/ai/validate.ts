import { generateReply } from './generate';
import type { AiConfig } from './types';

/**
 * Cheap liveness + auth check: one tiny generation against the
 * configured provider/model with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * on success. Used by the settings "Test key" button and before
 * persisting a config — the same "verify before save" discipline the
 * WhatsApp config uses with Meta.
 */
export async function validateAiCredentials(config: AiConfig): Promise<void> {
  await generateReply({
    config,
    systemPrompt:
      'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  });
}

/** Longest model id accepted for a tier (migration 077). */
export const MAX_MODEL_ID_LENGTH = 200;

/** The migration-077 (and 079) columns a settings save may write. */
export interface AiAgentV2Settings {
  model_small?: string | null;
  model_large?: string | null;
  model_routing?: boolean;
  pause_on_agent_reply?: boolean;
  auto_resume_minutes?: number | null;
  guardrail_retry?: boolean;
  /** Migration 079: answer on every connected number. */
  reply_on_all_numbers?: boolean;
}

const V2_BOOLEANS = [
  'model_routing',
  'pause_on_agent_reply',
  'guardrail_retry',
  'reply_on_all_numbers',
] as const;

/**
 * Validate the AI agent v2 fields of a config save. Each is optional:
 * an absent key is left out of `values`, so a partial save leaves the
 * stored value alone. Tier models are trimmed and blank means null
 * ("use `model`"); auto_resume_minutes is null or an integer in the
 * 5..10080 the database CHECK allows.
 */
export function parseAiAgentV2Settings(
  body: Record<string, unknown>
): { ok: true; values: AiAgentV2Settings } | { ok: false; error: string } {
  const values: AiAgentV2Settings = {};

  for (const key of ['model_small', 'model_large'] as const) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw !== null && typeof raw !== 'string') {
      return { ok: false, error: `${key} must be a string or null` };
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length > MAX_MODEL_ID_LENGTH) {
      return {
        ok: false,
        error: `${key} must be at most ${MAX_MODEL_ID_LENGTH} characters`,
      };
    }
    values[key] = trimmed || null;
  }

  for (const key of V2_BOOLEANS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (typeof raw !== 'boolean') {
      return { ok: false, error: `${key} must be true or false` };
    }
    values[key] = raw;
  }

  if ('auto_resume_minutes' in body) {
    const raw = body.auto_resume_minutes;
    if (raw === null) {
      values.auto_resume_minutes = null;
    } else if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 5 ||
      raw > 10080
    ) {
      return {
        ok: false,
        error:
          'auto_resume_minutes must be a whole number of minutes from 5 to 10080, or null to never resume',
      };
    } else {
      values.auto_resume_minutes = raw;
    }
  }

  return { ok: true, values };
}
