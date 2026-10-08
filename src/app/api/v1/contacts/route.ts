// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports a `?search=` (name/phone) filter. Create is find-or-create
// by phone: an existing match returns 200 with `created: false`; a new
// row returns 201 with `created: true`.
//
// Contact tags are retired. `?tag=` is still accepted and answers an
// empty page (no contact carries a tag), and a `tags` field in the
// create body is ignored, so an older client neither errors nor
// silently gets an unfiltered list.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  getContactById,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import { validateContactPhone } from '@/lib/contacts/phone-validation';

// PostgREST filter values are comma/paren-delimited; strip anything
// that could break the `.or()` grammar before interpolating a search
// term. Leaves the characters a phone or name legitimately contains.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');

    // No contact carries a tag any more, so a tag filter matches none.
    if (url.searchParams.get('tag')) return okList([], null);

    let query = ctx.supabase
      .from('contacts')
      .select(CONTACT_SELECT)
      .eq('account_id', ctx.accountId);

    if (search) {
      query = query.or(`name.ilike.*${search}*,phone.ilike.*${search}*`);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/contacts] list error:', error);
      return fail('internal', 'Failed to list contacts', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeContact(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }
    // Stricter than E.164 on purpose: a local or truncated number is
    // accepted by the gateway as 'sent' and never reaches anyone. Done
    // here, not in findOrCreateContact, because the v1 broadcast path
    // shares that helper and counts a bad recipient as rejected.
    const checked = validateContactPhone(phone, "'phone'");
    if (!checked.ok) {
      return fail('bad_request', checked.error, 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone: checked.normalized,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        company: typeof body.company === 'string' ? body.company : undefined,
      }
    );

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
