// ============================================================
// GET /api/v1/compass/notifications/{idempotency_key}
// Scope: compass_notifications:send
//
// What happened to one notification: our claim status (sending / sent
// / failed, with the error) plus WhatsApp's delivery progress
// (`delivery_status`: sent → delivered → read). This is what Compass
// calls after a timeout, instead of guessing whether to resend.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getNotificationByKey } from '@/lib/compass/notify';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'compass_notifications:send');
    const { key } = await params;
    const notification = await getNotificationByKey(
      ctx.supabase,
      ctx.accountId,
      key
    );
    if (!notification) {
      return fail(
        'not_found',
        'No notification with this idempotency_key',
        404
      );
    }
    return ok(notification);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
