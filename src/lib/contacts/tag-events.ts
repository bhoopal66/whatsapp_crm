import type { SupabaseClient } from '@supabase/supabase-js';

import type { AutomationContext } from '@/lib/automations/engine';
import { addContactTagIfAbsent } from './tag-write';

interface AddContactTagAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  tagId: string;
  /** Unused since the `tag_added` trigger was retired; kept so callers
   *  that pass their run's context keep compiling. */
  context?: AutomationContext;
}

export interface AddContactTagResult {
  added: boolean;
  /** Always false: contact tags no longer trigger automations (chat
   *  tags do, through `chat_tag_set`). */
  dispatched: false;
  reason?: 'duplicate';
}

/**
 * Central server-side contact tag writer. It used to dispatch the
 * `tag_added` automation trigger; that trigger was retired with contact
 * tags, so it now only writes the join row.
 */
export async function addContactTagAndDispatch(
  input: AddContactTagAndDispatchInput
): Promise<AddContactTagResult> {
  const added = await addContactTagIfAbsent(input.db, {
    accountId: input.accountId,
    contactId: input.contactId,
    tagId: input.tagId,
  });

  if (!added) return { added: false, dispatched: false, reason: 'duplicate' };
  return { added: true, dispatched: false };
}
