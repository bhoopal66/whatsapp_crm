// ============================================================
// GET /api/pbx/voicemail — the caller's own voicemail box.
//   → { messages: [{ id, callerNumber, callerName, at, durationSeconds,
//       read, contactId }], unread, total }
//
// The box is ALWAYS the caller's own extension (pbx_my_extension(), on
// the caller's client); nothing in the request names one. One page of
// up to 100 messages (vm/get), newest first; `unread` counts that page
// and `total` is the PBX's count of the whole box. `at` is the PBX's
// display time read in its zone (parsePbxTime), or null. contactId is
// a contact the caller's client can see with the caller's number. No
// PBX URL or token is ever returned. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { myExtension, noExtension, pbxFailure } from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import type { VoicemailListResponse } from '@/lib/pbx/voicemail';
import {
  VOICEMAIL_PAGE_SIZE,
  voicemailContacts,
  voicemailItems,
} from '@/lib/pbx/voicemail-server';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();

    const { api } = await pbxApiFor(pbxServiceDb(), ext.connectionId);
    const { total, items } = await api.listVoicemail({
      number: ext.extension,
      page: 1,
      pageSize: VOICEMAIL_PAGE_SIZE,
    });
    const contacts = await voicemailContacts(
      ctx.supabase,
      ctx.accountId,
      items.map((m) => m.callerNumber)
    );
    const messages = voicemailItems(items, contacts);
    const body: VoicemailListResponse = {
      messages,
      unread: messages.filter((m) => !m.read).length,
      total,
    };
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
