/**
 * Decision log writer (ts_decision_log). Writes through the service-role
 * store (store.ts). A failed write is reported, never thrown into the message path.
 */
import { createHash, createHmac } from 'node:crypto';
import type { CheckName } from './config';
import type { TsStore } from './store';

export interface DecisionRecord {
  check: CheckName;
  accountId: string;
  contactId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  policyVersion: number | null;
  modelId: string | null;
  questionSetVersion: string;
  language?: string | null;
  /** Redacted state; only its hash is stored. */
  redactedState: unknown;
  answers: unknown;
  decision: string;
  reasonCodes: string[];
  acted: boolean;
  shadow: boolean;
  fallbackUsed: boolean;
  latencyMs: number | null;
  inputTokens: number | null;
  errorCode: string | null;
}

/**
 * Hash of the redacted state. With a server-side key (TS_LOG_HASH_KEY) this is
 * HMAC-SHA256, so short messages ("stop") cannot be recovered by guessing.
 */
export function stateHash(state: unknown, key?: string): string {
  const data = stableStringify(state);
  return key
    ? createHmac('sha256', key).update(data).digest('hex')
    : createHash('sha256').update(data).digest('hex');
}

/** Keyed hash of a gateway message id, as stored in ts_decision_log.message_id. */
export function messageHash(messageId: string, key?: string): string {
  return stateHash(`message:${messageId}`, key);
}

/** JSON with sorted keys so equal states hash equally. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DecisionLogger {
  constructor(
    private readonly store: TsStore | undefined,
    private readonly onError: (
      err: unknown,
      rec: DecisionRecord
    ) => void = () => {},
    private readonly hashKey?: string
  ) {}

  /** Returns the new row id, or null if logging is off or failed. */
  async write(rec: DecisionRecord): Promise<string | null> {
    if (!this.store) return null;
    try {
      const uuidOrNull = (v: string | null | undefined) =>
        v && UUID.test(v) ? v : null;
      return await this.store.insertDecision({
        account_id: rec.accountId,
        contact_id: uuidOrNull(rec.contactId),
        conversation_id: rec.conversationId ?? null,
        // A gateway message id is not opaque: a Meta wamid embeds the
        // customer's phone number. Only its keyed hash is stored; the
        // same hash of messages.message_id finds the row again.
        message_id: rec.messageId
          ? messageHash(rec.messageId, this.hashKey)
          : null,
        check_name: rec.check,
        policy_version: rec.policyVersion,
        model_id: rec.modelId,
        question_set_version: rec.questionSetVersion,
        language: rec.language ?? null,
        state_hash: stateHash(rec.redactedState, this.hashKey),
        answers: rec.answers === undefined ? null : rec.answers,
        decision: rec.decision,
        reason_codes: rec.reasonCodes,
        acted: rec.acted,
        shadow: rec.shadow,
        fallback_used: rec.fallbackUsed,
        latency_ms: rec.latencyMs === null ? null : Math.round(rec.latencyMs),
        input_tokens: rec.inputTokens,
        error_code: rec.errorCode,
      });
    } catch (err) {
      this.onError(err, rec);
      return null;
    }
  }
}
