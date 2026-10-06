import type { AlertSink, TypeSafeGateway } from '../client';
import {
  checkState,
  type CheckName,
  type CheckState,
  type Ts013Config,
} from '../config';
import type { DecisionLogger } from '../log';
import type { PolicyStore, SwitchesStore } from '../policy';
import { redact } from '../redact';

export interface CheckDeps {
  config: Ts013Config;
  gateway: TypeSafeGateway;
  policies: PolicyStore;
  /** Each account's own switches (Settings → AI safety checks). */
  switches: SwitchesStore;
  logger: DecisionLogger;
  alert: AlertSink;
  now?: () => Date;
}

/** Identifiers carried into the decision log. */
export interface Ref {
  /** Tenancy key: selects the account's approved policy and scopes the log row. */
  accountId: string;
  contactId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}

/**
 * Fields common to every decision.
 * HOST RULE: when `act` is false, ignore the decision and do what wacrm does today.
 */
export interface DecisionMeta {
  act: boolean;
  shadow: boolean;
  shadowReasons: string[];
  fallbackUsed: boolean;
  errorCode: string | null;
  reasonCodes: string[];
  policyVersion: number | null;
  modelId: string | null;
  decisionId: string | null;
  latencyMs: number;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * Caps one free-text field before it is redacted and sent. TypeSafe's
 * documented budget is 32k tokens for state plus the longest question;
 * a WhatsApp message alone can run to ~65k characters.
 */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * Like `clip`, but keeps the END: for a burst of customer messages joined
 * oldest-first, the newest one ("please stop") must survive.
 */
export const clipTail = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(-(max - 1)).trimStart()}`;

/**
 * Clip, redact, clip again. Redaction normalises to NFKC, which can grow
 * text (one ligature, U+FDFA, becomes 18 characters), so the cap is
 * re-applied to what is actually sent. `tail` keeps the end instead: for a
 * customer message the newest words matter most.
 */
export function redactClipped(
  text: string,
  max: number,
  { tail = false }: { tail?: boolean } = {}
): string {
  const cut = tail ? clipTail : clip;
  return cut(redact(cut(text, max)).text, max);
}

/** Whether `check` runs, and acts, for this account right now. */
export async function stateFor(
  deps: Pick<CheckDeps, 'config' | 'switches'>,
  check: CheckName,
  accountId: string
): Promise<CheckState> {
  const sw = await deps.switches.get(accountId);
  return checkState(deps.config, sw, check, accountId);
}
