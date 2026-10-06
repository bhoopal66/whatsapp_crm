// ============================================================
// POST /api/v1/compass/notifications — send a status notification
// GET  /api/v1/compass/notifications — list sent notifications
//
// Scope: compass_notifications:send (both).
//
// The Taamul Compass integration (migration 056, docs/compass.md).
// Always sent on the Whapi number, into the customer's existing chat
// without changing who handles it, at most once per idempotency_key —
// the rules and their reasons are in lib/compass/notify.ts.
//
// Body:
//   {
//     "idempotency_key": "APP-2291:approved",   // required, unique per status change
//     "compass_id": "CUST-1001",                // and/or "to"
//     "to": "+971501234567",                    // overrides the synced phone
//     "text": "Your application is approved",   // required for type=text
//     "type": "text",                           // text | image | document
//     "media_url": "https://…/letter.pdf",      // image/document only
//     "filename": "approval-letter.pdf",
//     "event": "application.status_changed",    // free labels, echoed back
//     "reference": "APP-2291",
//     "name": "Jane Doe"                        // names a NEW contact only
//   }
//
// 201 sent now · 200 duplicate (already sent; nothing re-sent)
//   { "data": { …notification, "duplicate", "contact_created",
//               "conversation_created" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  NOTIFICATION_SELECT,
  NotifyError,
  parseNotificationRequest,
  sendCompassNotification,
  serializeNotification,
} from '@/lib/compass/notify';
import { SendMessageError } from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'compass_notifications:send');
    const body = await request.json().catch(() => null);
    const req = parseNotificationRequest(body);

    const outcome = await sendCompassNotification(
      ctx.supabase,
      ctx.accountId,
      req
    );

    return ok(
      {
        ...outcome.notification,
        duplicate: outcome.duplicate,
        contact_created: outcome.contactCreated,
        conversation_created: outcome.conversationCreated,
      },
      outcome.duplicate ? 200 : 201
    );
  } catch (err) {
    if (err instanceof NotifyError || err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'compass_notifications:send');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const compassId = url.searchParams.get('compass_id');

    let query = ctx.supabase
      .from('compass_notifications')
      .select(NOTIFICATION_SELECT)
      .eq('account_id', ctx.accountId);

    if (status) {
      if (!['sending', 'sent', 'failed'].includes(status)) {
        return fail(
          'bad_request',
          "'status' must be sending, sent or failed",
          400
        );
      }
      query = query.eq('status', status);
    }
    if (compassId) query = query.eq('compass_id', compassId);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/compass/notifications] list error:', error);
      return fail('internal', 'Failed to list notifications', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeNotification(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
