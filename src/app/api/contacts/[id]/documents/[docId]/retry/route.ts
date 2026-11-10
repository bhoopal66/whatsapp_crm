// ============================================================
// POST /api/contacts/[id]/documents/[docId]/retry — put a document the
// NAS worker could not save back in its queue (migration 178's
// customer_documents_retry). The function decides, on the caller's RLS
// client: owner/admin of the active account, a 'failed' document.
// Its hints map to NOT_ALLOWED 403, NOT_FOUND 404, STATE 409.
// Answers `{ status }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/memory/contact-http';

type Params = { params: Promise<{ id: string; docId: string }> };

const REFUSALS: Record<string, { status: number; error: string }> = {
  NOT_ALLOWED: { status: 403, error: 'Not allowed' },
  NOT_FOUND: { status: 404, error: 'Document not found' },
  STATE: { status: 409, error: 'Only a document that failed can be retried' },
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, docId } = await params;
    if (!isUuid(id) || !isUuid(docId))
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    // The document must belong to the customer in the path, read through
    // the caller's RLS client: a mismatch (or a document they cannot see)
    // is 404 rather than retrying it through another customer's URL.
    const { data: doc, error: docError } = await ctx.supabase
      .from('customer_documents')
      .select('id')
      .eq('id', docId)
      .eq('contact_id', id)
      .maybeSingle();
    if (docError) throw new Error(`customer_documents read: ${docError.code}`);
    if (!doc)
      return NextResponse.json(
        { error: REFUSALS.NOT_FOUND.error },
        { status: 404 }
      );

    const { data, error } = await ctx.supabase.rpc('customer_documents_retry', {
      p_id: docId,
    });
    if (error) {
      const refusal = REFUSALS[error.hint ?? ''];
      if (refusal)
        return NextResponse.json(
          { error: refusal.error },
          { status: refusal.status }
        );
      throw new Error(`customer_documents_retry: ${error.code}`);
    }
    return NextResponse.json({
      status: typeof data === 'string' ? data : 'pending',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
