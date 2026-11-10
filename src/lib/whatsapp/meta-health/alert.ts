/**
 * The `meta_number_alert` bell (migration 188, section 10): one
 * notifications row per live owner and admin of the account when the
 * Meta number's assessed state gets worse. Recipients and row shape
 * follow `alertAdmins` in `lib/whatsapp/channel-health.ts`, plus the
 * deactivation filter: a deactivated owner is not told.
 *
 * The body is our own wording, the state and short reason codes
 * (QUALITY_YELLOW, STATUS_RESTRICTED); nothing from Meta's payload is
 * copied in. Best-effort: never throws, a failure is one log line.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAlarmTransition } from './state';
import type { AssessedState } from './values';

export interface MetaNumberAlertArgs {
  accountId: string;
  configId: string;
  previous: AssessedState | null;
  next: AssessedState;
  reasons: string[];
}

const STATE_WORDING: Record<AssessedState, string> = {
  NORMAL: 'normal',
  THROTTLED: 'throttled',
  MARKETING_PAUSED: 'marketing paused',
  ALL_PAUSED: 'all sending paused',
};

/** A reason code is ours only if it looks like one; anything else is dropped. */
const REASON_CODE = /^[A-Z0-9_]{1,40}$/;
const MAX_REASONS = 5;

function reasonCodes(reasons: string[]): string[] {
  return reasons.filter((r) => REASON_CODE.test(r)).slice(0, MAX_REASONS);
}

export function metaNumberAlertBody(
  next: AssessedState,
  reasons: string[]
): string {
  const codes = reasonCodes(reasons);
  return (
    `Meta number health: ${STATE_WORDING[next]}.` +
    (codes.length > 0 ? ` Reasons: ${codes.join(', ')}.` : '')
  );
}

export async function ringMetaNumberAlert(
  admin: SupabaseClient,
  args: MetaNumberAlertArgs
): Promise<void> {
  const { accountId, configId, previous, next } = args;
  // Only a worse state rings; a recovery or a repeat is silent.
  if (!isAlarmTransition(previous, next)) return;
  try {
    const { data: admins, error: profilesError } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
      .is('deactivated_at', null);
    if (profilesError) throw new Error(profilesError.message);

    const reasons = reasonCodes(args.reasons);
    const rows = ((admins ?? []) as Array<{ user_id: string }>).map((p) => ({
      account_id: accountId,
      user_id: p.user_id,
      type: 'meta_number_alert',
      conversation_id: null,
      contact_id: null,
      actor_user_id: null,
      title: 'The Meta WhatsApp number needs attention',
      body: metaNumberAlertBody(next, reasons),
      meta: { config_id: configId, previous, next, reasons },
    }));
    if (rows.length === 0) return;

    const { error: insertError } = await admin
      .from('notifications')
      .insert(rows);
    if (insertError) throw new Error(insertError.message);
  } catch (err) {
    console.error(
      `[meta-health] ${configId} (account ${accountId}): ${previous ?? 'none'} → ${next} alert not saved: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
