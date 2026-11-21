/**
 * Server-only wiring for Submission Groups (module 018a): one service per
 * account over the service-role store and that account's Whapi numbers.
 * Routes check the caller first (API key or session); everything here runs
 * as the service role, which writes only through the sg_* functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/groups/server';
import { SubmissionGroupService } from './service';
import {
  addStaffNumber,
  removeStaffNumber,
  type StaffNumberDeps,
} from './staff-number';
import { SubmissionGroupStore, type SubmissionGroup } from './store';
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
    staffNumberJoined: (groupId, phone) =>
      store.staffNumberJoined(groupId, phone),
    welcomeDetails: async (groupId) => {
      const { data: c, error } = await admin
        .from('cases')
        .select('bank_code, product, account_id')
        .eq('group_id', groupId)
        .maybeSingle();
      if (error) throw error;
      if (!c) return null;
      const code = (c.bank_code as string | null) ?? null;
      let name: string | null = null;
      if (code) {
        const { data: b, error: be } = await admin
          .from('case_banks')
          .select('name')
          .eq('account_id', c.account_id as string)
          .eq('code', code)
          .maybeSingle();
        if (be) throw be;
        name = (b?.name as string | null) ?? null;
      }
      return {
        product: (c.product as string | null) ?? null,
        bankName: name ?? code,
      };
    },
  });
}

function staffNumberDeps(
  accountId: string,
  admin: SupabaseClient
): StaffNumberDeps {
  const store = new SubmissionGroupStore(admin);
  const api = createWhapiGroupsApi(admin, accountId);
  return {
    savedPhone: (account, user) => store.staffSavedPhone(account, user),
    customerPhone: async (contactId) =>
      (await store.contactConsent(contactId)).phone,
    getParticipants: (c, g) => api.getParticipants(c, g),
    addParticipant: (c, g, p) => api.addParticipant(c, g, p),
    removeParticipant: (c, g, p) => api.removeParticipant(c, g, p),
    logger: {
      warn: (msg, meta) => console.warn(`[submission-groups] ${msg}`, meta),
    },
  };
}

/** Access given: the person's saved number joins the WhatsApp group (never throws). */
export function linkStaffNumber(
  group: SubmissionGroup,
  userId: string,
  admin: SupabaseClient = supabaseAdmin()
) {
  return addStaffNumber(staffNumberDeps(group.accountId, admin), group, userId);
}

/** Access removed: the person's saved number leaves the WhatsApp group (never throws). */
export function unlinkStaffNumber(
  group: SubmissionGroup,
  userId: string,
  admin: SupabaseClient = supabaseAdmin()
) {
  return removeStaffNumber(
    staffNumberDeps(group.accountId, admin),
    group,
    userId
  );
}
