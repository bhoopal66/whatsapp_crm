// ============================================================
// /api/contacts/[id]/documents — the customer's documents folder
// (migration 178): the Documents card on the customer page and, with
// `?summary=1`, the inbox contact panel's row.
//
// Every read is the CALLER's RLS client: a person sees a customer's
// folder and documents exactly when they can see the customer. The
// contact is read first, so one they cannot see is 404.
//
// GET → `{ folder, documents }` (newest first, at most 200), or
// `{ folder, count }` with `?summary=1`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  DOCUMENT_COLUMNS,
  DOCUMENTS_LIST_MAX,
  FOLDER_COLUMNS,
  documentsView,
  folderView,
} from '@/lib/customer-docs/view';
import { isUuid } from '@/lib/memory/contact-http';

type Params = { params: Promise<{ id: string }> };

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: 'Invalid contact id' },
        { status: 400 }
      );

    const { data: contact, error: contactError } = await ctx.supabase
      .from('contacts')
      .select('id, account_id')
      .eq('id', id)
      .maybeSingle();
    if (contactError) throw new Error(`contacts read: ${contactError.code}`);
    if (!contact || contact.account_id !== ctx.accountId)
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    const folderRead = ctx.supabase
      .from('customer_doc_folders')
      .select(FOLDER_COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', id)
      .maybeSingle();

    if (new URL(request.url).searchParams.get('summary') === '1') {
      const [folderRes, countRes] = await Promise.all([
        folderRead,
        ctx.supabase
          .from('customer_documents')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', ctx.accountId)
          .eq('contact_id', id),
      ]);
      if (folderRes.error)
        throw new Error(`folder read: ${folderRes.error.code}`);
      if (countRes.error)
        throw new Error(`documents count: ${countRes.error.code}`);
      return NextResponse.json(
        { folder: folderView(folderRes.data), count: countRes.count ?? 0 },
        { headers: NO_STORE }
      );
    }

    const [folderRes, docsRes] = await Promise.all([
      folderRead,
      ctx.supabase
        .from('customer_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('account_id', ctx.accountId)
        .eq('contact_id', id)
        .order('received_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(DOCUMENTS_LIST_MAX),
    ]);
    if (folderRes.error)
      throw new Error(`folder read: ${folderRes.error.code}`);
    if (docsRes.error) throw new Error(`documents read: ${docsRes.error.code}`);
    return NextResponse.json(
      {
        folder: folderView(folderRes.data),
        documents: documentsView(docsRes.data),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
