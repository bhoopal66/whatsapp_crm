// ============================================================
// /api/cases/[id]/last-message — the customer's last message in their
// WhatsApp chat, for the case page's Overview.
//
// GET (any case role): `{ message: { conversationId, text, at } | null }`.
// Read through the CALLER's RLS client, so a person who may read the case
// but not the chat gets `null`, never the text. Company chats only
// (personal_owner_id IS NULL). Unlike /conversation (an audited read of
// the case group) this touches only the contact's own inbox thread.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse, loadCaseForCaller } from '@/lib/cases/http';
import { snippet } from '@/lib/cases/overview';
import { caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

const NONE = { message: null };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      { write: false }
    );
    if (!c.contactId) return NextResponse.json(NONE);

    const conv = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', c.contactId)
      .is('personal_owner_id', null)
      .limit(1)
      .maybeSingle();
    if (conv.error || !conv.data) return NextResponse.json(NONE);

    const msg = await ctx.supabase
      .from('messages')
      .select('content_text, created_at')
      .eq('conversation_id', conv.data.id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (msg.error || !msg.data) return NextResponse.json(NONE);

    const text =
      typeof msg.data.content_text === 'string' && msg.data.content_text.trim()
        ? snippet(msg.data.content_text)
        : null;
    return NextResponse.json({
      message: {
        conversationId: conv.data.id,
        text,
        at: msg.data.created_at,
      },
    });
  } catch (err) {
    return caseErrorResponse(err, 'last-message GET');
  }
}
