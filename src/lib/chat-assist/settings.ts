/**
 * Reading and setting the workspace's chat-assistant switch (323).
 * Reads go through the caller's client (members read it under RLS);
 * the only writer is `inbox_assistant_set_enabled()`, which checks admin+ of
 * the ACTIVE account in SQL. A read that fails is treated as off: the
 * panel fails closed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { chatAssistEnabledFrom } from './gate';

export async function readChatAssistEnabled(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('inbox_assistant_settings')
      .select('enabled')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error(
        `[chat-assist] switch read failed (${error.code ?? '-'}); treated as off`
      );
      return false;
    }
    return chatAssistEnabledFrom(data);
  } catch {
    console.error('[chat-assist] switch read threw; treated as off');
    return false;
  }
}

export type SetSwitchResult =
  { ok: true; enabled: boolean } | { ok: false; reason: 'forbidden' | 'error' };

export async function setChatAssistEnabled(
  db: SupabaseClient,
  enabled: boolean
): Promise<SetSwitchResult> {
  const { data, error } = await db.rpc('inbox_assistant_set_enabled', {
    p_enabled: enabled,
  });
  if (error)
    return {
      ok: false,
      reason: error.code === '42501' ? 'forbidden' : 'error',
    };
  return { ok: true, enabled: chatAssistEnabledFrom(data) };
}
