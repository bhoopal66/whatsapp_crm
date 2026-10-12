import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { NEW_STATE } from '@/lib/journeys/types';
import { WORKFLOWS, fail } from './run-event';

const PRODUCTS = new Set(['POS', 'ACCOUNT', 'LOAN']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface FileRow {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  state: string;
  product: string | null;
  entry: string | null;
  outcome: { kind: string; reason: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

/**
 * The account's journey files for the Journeys screen (any member; RLS
 * shows the journeys of customers the caller can see). Open files
 * first, then by last change. `?state=` (a workflow state), `?product=`
 * (POS | ACCOUNT | LOAN), `?limit=` (1–200, default 50).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const q = new URL(request.url).searchParams;
    const state = q.get('state') || null;
    const product = q.get('product') || null;
    const limitParam = q.get('limit');
    if (
      state &&
      state !== NEW_STATE &&
      !Object.values(WORKFLOWS).some((d) => Object.hasOwn(d.states, state))
    )
      return fail(400, `Unknown journey state ${state}`);
    if (product && !PRODUCTS.has(product))
      return fail(400, 'product must be POS, ACCOUNT or LOAN');
    const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      return fail(400, `limit must be a whole number from 1 to ${MAX_LIMIT}`);

    let query = supabase
      .from('journey_files')
      .select(
        'id, contact_id, conversation_id, state, product, entry, outcome:body->outcome, created_at, updated_at, closed_at, contact:contacts!journey_files_contact_fkey(name, phone)'
      )
      .eq('account_id', accountId);
    if (state) query = query.eq('state', state);
    if (product) query = query.eq('product', product);
    const { data, error } = await query
      .order('closed_at', { ascending: false, nullsFirst: true })
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`journey_files: ${error.message}`);

    const journeys = ((data ?? []) as unknown as FileRow[]).map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      contactName: r.contact?.name ?? null,
      contactPhone: r.contact?.phone ?? null,
      conversationId: r.conversation_id,
      state: r.state,
      product: r.product,
      entry: r.entry,
      outcome: r.outcome,
      open: r.closed_at === null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
    }));
    return Response.json({ journeys });
  } catch (err) {
    return toErrorResponse(err);
  }
}
