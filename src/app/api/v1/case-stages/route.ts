// ============================================================
// GET /api/v1/case-stages?bank=FAB — the stage list of a bank
// (scope: submission_groups:read). Taamul Compass validates its
// status -> stage map against it. An unknown bank answers the account's
// default list (case_stages_for_bank, migration 122).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { FINAL_STAGES } from '@/lib/cases/types';
import { PRESUB_STAGES } from '@/lib/cases/ui';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:read');
    const bank = (new URL(request.url).searchParams.get('bank') ?? '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9_]{2,32}$/.test(bank))
      return fail(
        'bad_request',
        "'bank' is required: 2-32 letters, digits or underscores",
        400
      );
    const { data, error } = await ctx.supabase.rpc('case_stages_for_bank', {
      p_account: ctx.accountId,
      p_bank_code: bank,
    });
    if (error) {
      console.error('[api/v1/case-stages]', error);
      return fail('internal', 'Failed to read the stages', 500);
    }
    return ok({
      bank,
      stages: (data ?? []) as string[],
      presubmission: [...PRESUB_STAGES],
      final: [...FINAL_STAGES],
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
