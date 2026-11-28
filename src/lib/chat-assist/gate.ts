/**
 * Who may use the in-chat AI assistant, and when (migration 321).
 *
 * Two conditions, both required: the workspace switch is on
 * (`inbox_assistant_settings.enabled`, off by default, no row = off) and the
 * caller is agent or up. Only an owner or admin turns the switch, through
 * `inbox_assistant_set_enabled()`. Pure, so the panel's routes and the UI
 * share one answer.
 */
import {
  canEditSettings,
  canUseChatAssistant,
  type AccountRole,
} from '@/lib/auth/roles';

/** Mirrors 321's column default: a workspace starts with it off. */
export const CHAT_ASSIST_DEFAULT_ENABLED = false;

export type ChatAssistRefusal = 'off' | 'role';

export type ChatAssistGate =
  { ok: true } | { ok: false; reason: ChatAssistRefusal };

/** The switch as stored: only an explicit `true` is on. */
export function chatAssistEnabledFrom(row: unknown): boolean {
  if (!row || typeof row !== 'object') return CHAT_ASSIST_DEFAULT_ENABLED;
  return (row as { enabled?: unknown }).enabled === true;
}

/**
 * Whether this person may use the panel now. The role is checked first:
 * a viewer is told it is not for them whatever the switch says.
 */
export function chatAssistGate(args: {
  role: AccountRole;
  enabled: boolean;
}): ChatAssistGate {
  if (!canUseChatAssistant(args.role)) return { ok: false, reason: 'role' };
  if (args.enabled !== true) return { ok: false, reason: 'off' };
  return { ok: true };
}

/** Owner / admin: the only people who turn the switch. */
export function canToggleChatAssist(role: AccountRole): boolean {
  return canEditSettings(role);
}

/** The HTTP answer for a refusal: 403 either way, with a code the panel words. */
export function chatAssistRefusalBody(reason: ChatAssistRefusal): {
  error: string;
  code: 'chat_assist_off' | 'chat_assist_role';
} {
  return reason === 'off'
    ? {
        error: 'The chat assistant is off for this workspace.',
        code: 'chat_assist_off',
      }
    : {
        error: 'The chat assistant is for agents and up.',
        code: 'chat_assist_role',
      };
}
