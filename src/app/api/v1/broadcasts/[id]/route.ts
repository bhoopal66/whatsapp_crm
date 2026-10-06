// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent', or 'failed' when every
// recipient failed (which can follow 'sent': WhatsApp may accept a
// send and fail it later); the delivered/read counts continue to
// climb as delivery webhooks arrive. It can stay 'sending' when the
// sending number itself fails (revoked token, logged out): delivery
// stops, the rest stay pending, and only a Resume from the dashboard
// finishes it. A dashboard Resume or Retry failed also moves a
// 'sent'/'failed' campaign back to 'sending'.
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('broadcasts')
      .select(
        'id, name, template_name, template_language, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, created_at, updated_at'
      )
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/broadcasts] read error:', error);
      return fail('internal', 'Failed to read broadcast', 500);
    }
    if (!data) return fail('not_found', 'Broadcast not found', 404);

    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
