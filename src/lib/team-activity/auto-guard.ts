// ============================================================
// The number's daily new-chat limit for AUTOMATIC senders (migration
// 204, team_activity_auto_check): broadcasts, the public API, flows and
// automations. The SQL refuses only a START (no message for 24 hours,
// unless the customer wrote last) on a company phone number (Whapi or
// OpenWA) at or above its daily limit, while the account's hard
// restrictions, automatic senders and the daily-number rule are on; it
// records the block itself.
//
// A guard rail, not a reason for a send to fail: every error, including
// a database without migration 204, lets the message through, as the
// SQL does. Callers ask only for a linked-device channel.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isLinkedDeviceProvider,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';

import { isMissingFunction } from './db-errors';

export interface AutoStartCheck {
  blocked: boolean;
  blockId?: string;
  started?: number;
  limit?: number;
  warmingUp?: boolean;
}

/** The public API's error code for a refused start. */
export const NUMBER_DAILY_LIMIT_CODE = 'number_daily_limit';

const ALLOW: AutoStartCheck = { blocked: false };
let missingLogged = false;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Ask whether an automatic sender may message this conversation on this
 * number. `admin` must be a service-role client: the function is granted
 * to the service role only. Anything but a linked-device channel is
 * allowed without a round trip. A null conversation (a broadcast to a
 * contact with no chat yet) is passed through for the SQL to judge.
 */
export async function checkAutoStartAllowed(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  channel: Pick<WhatsAppChannel, 'id' | 'provider'>
): Promise<AutoStartCheck> {
  if (!isLinkedDeviceProvider(channel.provider)) return ALLOW;
  try {
    const { data, error } = await admin.rpc('team_activity_auto_check', {
      p_account: accountId,
      p_conversation: conversationId,
      p_channel_id: channel.id,
    });
    if (error) {
      if (isMissingFunction(error)) {
        if (!missingLogged) {
          missingLogged = true;
          console.warn(
            '[team-activity] team_activity_auto_check is missing — apply migration 204.'
          );
        }
      } else {
        console.error(
          '[team-activity] automatic-sender check failed:',
          error.message
        );
      }
      return ALLOW;
    }
    const o = (data ?? {}) as Record<string, unknown>;
    if (o.blocked !== true) return ALLOW;
    const detail = (o.detail ?? {}) as Record<string, unknown>;
    return {
      blocked: true,
      blockId: typeof o.block_id === 'string' ? o.block_id : undefined,
      started: num(detail.started),
      limit: num(detail.limit),
      warmingUp: detail.warming_up === true,
    };
  } catch (err) {
    console.error(
      '[team-activity] automatic-sender check failed:',
      err instanceof Error ? err.message : err
    );
    return ALLOW;
  }
}

/**
 * The contact's company chat (migration 191: personal chats are never
 * an automatic sender's), or null when it has none yet or the read
 * failed. Never throws.
 */
export async function companyConversationId(
  admin: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .is('personal_owner_id', null)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

/** Stored on the recipient / step and returned by the public API. */
export function numberDailyLimitMessage(check: AutoStartCheck): string {
  const limit = check.limit ?? check.started;
  const reached =
    limit === undefined
      ? 'has reached its daily limit of new chats'
      : `has started ${limit} new chats today, its daily limit${check.warmingUp ? ' while it warms up' : ''}`;
  return `This WhatsApp number ${reached}. New chats on it can start again tomorrow; replies to existing chats still go out.`;
}

/** Thrown by {@link assertAutoStartAllowed}; the engines record it as a failed step. */
export class NumberDailyLimitError extends Error {
  readonly code = NUMBER_DAILY_LIMIT_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'NumberDailyLimitError';
  }
}

/**
 * The flow and automation senders' form: throw before the gateway when
 * the start is refused. Their runners already catch a send error and
 * record the step as failed, so nothing is sent and the dispatch goes
 * on. `source` names the engine in the warning.
 */
export async function assertAutoStartAllowed(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  channel: Pick<WhatsAppChannel, 'id' | 'provider'>,
  source: string
): Promise<void> {
  const check = await checkAutoStartAllowed(
    admin,
    accountId,
    conversationId,
    channel
  );
  if (!check.blocked) return;
  console.warn(
    `[${source}] not sent: number ${channel.id} is at its daily new-chat limit (conversation ${conversationId}).`
  );
  throw new NumberDailyLimitError(numberDailyLimitMessage(check));
}
