// ============================================================
// GET    /api/v1/compass/contacts/{compass_id}  (compass_contacts:read)
// DELETE /api/v1/compass/contacts/{compass_id}  (compass_contacts:write)
//
// Addressed by Compass's own id, URL-encoded (Next decodes it). DELETE removes only the
// synced record: the CRM contact and any chat it became are the
// agents' working history and stay put.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  COMPASS_CONTACT_COLUMNS,
  serializeCompassContact,
} from '@/lib/compass/contacts';

type Params = { params: Promise<{ compassId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'compass_contacts:read');
    const { compassId } = await params;

    const { data, error } = await ctx.supabase
      .from('compass_contacts')
      .select(COMPASS_CONTACT_COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('compass_id', compassId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/compass/contacts/:id] read error:', error);
      return fail('internal', 'Failed to read Compass contact', 500);
    }
    if (!data) return fail('not_found', 'Compass contact not found', 404);
    return ok(serializeCompassContact(data as Record<string, unknown>));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'compass_contacts:write');
    const { compassId } = await params;

    const { data, error } = await ctx.supabase
      .from('compass_contacts')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('compass_id', compassId)
      .select('id');

    if (error) {
      console.error('[api/v1/compass/contacts/:id] delete error:', error);
      return fail('internal', 'Failed to delete Compass contact', 500);
    }
    if (!data || data.length === 0) {
      return fail('not_found', 'Compass contact not found', 404);
    }
    return ok({ deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
