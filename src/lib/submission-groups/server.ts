/**
 * Server-only wiring for Submission Groups (module 018a): one service per
 * account over the service-role store and that account's Whapi numbers.
 * Routes check the caller first (API key or session); everything here runs
 * as the service role, which writes only through the sg_* functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/groups/server';
import { SubmissionGroupService } from './service';
import { SubmissionGroupStore } from './store';
import { createWhapiGroupsApi } from './whapi-groups-api';

export { supabaseAdmin };

export function submissionGroupStore(
  admin: SupabaseClient = supabaseAdmin()
): SubmissionGroupStore {
  return new SubmissionGroupStore(admin);
}

/** The service for one account (the Whapi adapter loads that account's numbers). */
export function submissionGroupService(
  accountId: string,
  admin: SupabaseClient = supabaseAdmin()
): SubmissionGroupService {
  const store = new SubmissionGroupStore(admin);
  return new SubmissionGroupService({
    store,
    api: createWhapiGroupsApi(admin, accountId),
    consent: (contactId) => store.contactConsent(contactId),
    displayName: (userId, account) => store.displayName(userId, account),
  });
}
