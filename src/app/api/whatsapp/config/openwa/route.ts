import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { connectOpenWANumber } from '@/lib/whatsapp/openwa-number';

/**
 * POST /api/whatsapp/config/openwa — connect a shared number on the
 * self-hosted OpenWA gateway. Admin+, like every other WhatsApp
 * connection route. The work (session, scoped key, webhook, start, row,
 * undo on failure) is `connectOpenWANumber`, shared with a staff
 * member's own number (`/api/whatsapp/personal`).
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
  };
  const label =
    typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';

  return connectOpenWANumber({
    db: ctx.supabase,
    accountId: ctx.accountId,
    userId: ctx.userId,
    label,
    personal: false,
  });
}
