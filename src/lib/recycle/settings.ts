import type { SupabaseClient } from '@supabase/supabase-js';

import { settingsFromRow } from './rows';
import type { RecycleSettings } from './types';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;

export interface StoredRecycleSettings {
  settings: RecycleSettings;
  /** The row's version; null when there is no row (the defaults). */
  updatedAt: string | null;
}

/**
 * The workspace's recycling settings, or null when they could not be
 * read. Null is never "no row": the defaults saved over stored settings
 * would replace them.
 */
export async function readRecycleSettings(
  db: Db,
  accountId: string
): Promise<StoredRecycleSettings | null> {
  const { data, error } = await db
    .from('recycle_settings')
    .select('days, chat_tag_ids, case_outcomes, updated_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) return null;
  return {
    settings: settingsFromRow(data ?? null),
    updatedAt: (data?.updated_at as string | undefined) ?? null,
  };
}

/**
 * Saves the whole form (recycle_settings_set replaces every column), but
 * only over the version it was loaded from: `conflict` when a colleague
 * saved since.
 */
export async function saveRecycleSettings(
  db: Db,
  accountId: string,
  next: RecycleSettings,
  loadedAt: string | null
): Promise<'saved' | 'conflict' | 'failed'> {
  const current = await readRecycleSettings(db, accountId);
  if (!current) return 'failed';
  if (current.updatedAt !== loadedAt) return 'conflict';
  const { error } = await db.rpc('recycle_settings_set', {
    p_days: next.days,
    p_chat_tag_ids: next.chatTagIds,
    p_case_outcomes: next.caseOutcomes,
  });
  return error ? 'failed' : 'saved';
}
