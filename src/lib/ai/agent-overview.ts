import type { AiConfigFormValues } from './config-form';
import { effectiveCodes } from '@/lib/typesafe/partner-banks-draft';
import type {
  BankCatalogueEntry,
  PartnerBanksSetting,
} from '@/lib/typesafe/admin-types';

/**
 * The AI Agents Overview tab and the tab bar's status dots, as pure
 * figures. Everything here reads what is *saved*, not the form's
 * unsaved edits: the overview says what the bot is doing now.
 */

/** The safety layer's state, as the safety panel's header chip shows it
 *  (`effectiveState` in ai-safety-panel.tsx). */
export type SafetyState = 'off' | 'monitor' | 'live' | 'problem';

export type StatusDot = 'green' | 'amber' | null;

/**
 * Where auto-reply answers: every number; only the explicitly routed
 * one; or, with no explicit `ai_reply` route, the default number *and*
 * every other number of its provider, because `resolveAiReplyChannel`
 * then stays on the thread's own number whenever the providers match.
 * The default number has no name when no number is marked primary.
 */
export type AutoReplyScope =
  | { kind: 'all' }
  | { kind: 'only'; name: string }
  | { kind: 'default'; name: string | null };

export interface AgentOverview {
  assistant: { configured: boolean; on: boolean };
  autoReply: { on: boolean; scope: AutoReplyScope };
}

export function summariseAgentOverview({
  configured,
  saved,
  aiReplyRoute,
  numbers,
}: {
  configured: boolean;
  saved: Pick<
    AiConfigFormValues,
    'isActive' | 'autoReplyEnabled' | 'replyOnAllNumbers'
  >;
  /** The saved `ai_reply` route: null = no explicit route. */
  aiReplyRoute: string | null;
  numbers: readonly { id: string; name: string; isPrimary: boolean }[];
}): AgentOverview {
  const assistantOn = configured && saved.isActive;
  let scope: AutoReplyScope;
  if (saved.replyOnAllNumbers) {
    scope = { kind: 'all' };
  } else if (aiReplyRoute === null) {
    scope = {
      kind: 'default',
      name: numbers.find((n) => n.isPrimary)?.name ?? null,
    };
  } else {
    // A route to a number the list no longer has shows its id, as the
    // Auto-reply tab's picker does.
    scope = {
      kind: 'only',
      name: numbers.find((n) => n.id === aiReplyRoute)?.name ?? aiReplyRoute,
    };
  }
  return {
    assistant: { configured, on: assistantOn },
    // The bot loads its config only while the assistant is on.
    autoReply: { on: assistantOn && saved.autoReplyEnabled, scope },
  };
}

/** The Overview's "Reply on" line, as an `AiAgents` message. */
export function autoReplyScopeMessage(
  scope: AutoReplyScope
):
  | { key: 'overview.everyNumber' }
  | { key: 'overview.onlyOn'; values: { name: string } }
  | { key: 'overview.defaultAndOthers'; values: { name: string } }
  | { key: 'overview.defaultAndOthersUnnamed' } {
  if (scope.kind === 'all') return { key: 'overview.everyNumber' };
  if (scope.kind === 'only') {
    return { key: 'overview.onlyOn', values: { name: scope.name } };
  }
  return scope.name === null
    ? { key: 'overview.defaultAndOthersUnnamed' }
    : { key: 'overview.defaultAndOthers', values: { name: scope.name } };
}

/** The Settings Overview's AI Agents tile, as a message key. */
export type AgentTileStatus = 'notSetup' | 'aiOff' | 'aiOn' | 'aiAutoReply';

export function agentTileStatus(overview: AgentOverview): AgentTileStatus {
  if (!overview.assistant.configured) return 'notSetup';
  if (!overview.assistant.on) return 'aiOff';
  return overview.autoReply.on ? 'aiAutoReply' : 'aiOn';
}

/** Green while the bot replies on its own; no dot otherwise. */
export function autoReplyDot(overview: AgentOverview): StatusDot {
  return overview.autoReply.on ? 'green' : null;
}

/**
 * Green when Live, amber when only monitoring, none when off or not
 * known. A problem (every bot reply held) is amber too: the layer is
 * not acting as configured and needs a look.
 */
export function safetyDot(state: SafetyState | null): StatusDot {
  if (state === 'live') return 'green';
  if (state === 'monitor' || state === 'problem') return 'amber';
  return null;
}

/**
 * How many partner banks the account has: the ticked catalogue banks
 * (the built-in partners while the setting is null) plus its own.
 * Null when the backend sends no catalogue.
 */
export function partnerBankCount(
  saved: PartnerBanksSetting | null | undefined,
  catalogue: readonly BankCatalogueEntry[] | null | undefined
): number | null {
  if (!Array.isArray(catalogue)) return null;
  return (
    effectiveCodes(saved ?? null, catalogue).length +
    (saved?.custom.length ?? 0)
  );
}
