// ============================================================
// GET  /api/v1/compass/contacts — list synced Compass customers
//                                 (scope: compass_contacts:read)
// POST /api/v1/compass/contacts — sync (upsert) a batch of customers
//                                 (scope: compass_contacts:write)
//
// The Taamul Compass integration (migration 056, docs/compass.md).
// POST is the one sync call for both the initial backfill and every
// later change: records are keyed by `compass_id`, so sending one
// again updates it. A bad record is rejected by index while the rest
// of the batch is stored — see lib/compass/contacts.ts.
//
// Body:  { "contacts": [ { "compass_id", "name", "phone", "email",
//                           "company", "attributes" }, … ] }   ≤ 500
// 200:   { "data": { "received", "upserted", "rejected": [
//            { "index", "compass_id", "error" } ] } }
//
// GET supports `?search=` (name / phone / compass_id), `?updated_since=`
// (ISO timestamp), and the standard keyset `?limit` / `?cursor`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  MAX_SYNC_BATCH,
  COMPASS_CONTACT_COLUMNS,
  parseCompassContactBatch,
  serializeCompassContact,
  upsertCompassContacts,
} from '@/lib/compass/contacts';

// Same guard as /api/v1/contacts: keep only characters a name, phone
// or ERP id legitimately contains, so the term can't break `.or()`.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'compass_contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');
    const updatedSince = url.searchParams.get('updated_since');

    let query = ctx.supabase
      .from('compass_contacts')
      .select(COMPASS_CONTACT_COLUMNS)
      .eq('account_id', ctx.accountId);

    if (search) {
      query = query.or(
        `name.ilike.*${search}*,phone.ilike.*${search}*,compass_id.ilike.*${search}*`
      );
    }
    if (updatedSince) {
      const since = new Date(updatedSince);
      if (Number.isNaN(since.getTime())) {
        return fail(
          'bad_request',
          "'updated_since' must be an ISO 8601 timestamp",
          400
        );
      }
      query = query.gte('updated_at', since.toISOString());
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/compass/contacts] list error:', error);
      return fail('internal', 'Failed to list Compass contacts', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeCompassContact(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'compass_contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const records = body && typeof body === 'object' ? body.contacts : null;
    if (!Array.isArray(records)) {
      return fail('bad_request', 'Body must be { "contacts": [ … ] }', 400);
    }
    if (records.length === 0) {
      return ok({ received: 0, upserted: 0, rejected: [] });
    }
    if (records.length > MAX_SYNC_BATCH) {
      return fail(
        'bad_request',
        `At most ${MAX_SYNC_BATCH} contacts per request — split the batch`,
        400
      );
    }

    const { rows, rejected } = parseCompassContactBatch(records);
    let upserted = 0;
    try {
      upserted = await upsertCompassContacts(ctx.supabase, ctx.accountId, rows);
    } catch (err) {
      console.error('[api/v1/compass/contacts] sync error:', err);
      return fail('internal', 'Failed to store Compass contacts', 500);
    }

    return ok({ received: records.length, upserted, rejected });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
