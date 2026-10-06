// ============================================================
// POST /api/whatsapp/contacts/avatars
//
// Fill in WhatsApp profile pictures for contacts the inbox has loaded
// (migration 070). Body: { contactIds: string[] } — up to 50 ids.
// Answers { avatars: { [contactId]: url | null } } for the contacts
// whose picture was decided on this call: a new picture, or null for
// "none". Everything else (not due, no Whapi number, a failure that
// will be retried) is simply absent.
//
// Any member: the inbox is open to viewers, and this only fills in a
// column. The contacts are read through the CALLER's client, so RLS
// decides which ids count — nobody can trigger lookups for chats they
// cannot see. The writes and the upload then run as the service role
// (storage RLS would refuse a viewer), confined to the caller's account
// in `refreshContactAvatar`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { loadChannels } from '@/lib/whatsapp/channels';
import { probeChannel } from '@/lib/whatsapp/provider';
import {
  AVATAR_CONCURRENCY,
  createChannelGate,
  isAvatarDue,
  mapWithConcurrency,
  parseAvatarRequest,
  pickAvatarChannel,
  refreshContactAvatar,
} from '@/lib/whatsapp/contact-avatars';

// 50 contacts, 4 at a time, each a profile lookup plus a download.
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const parsed = parseAvatarRequest(await request.json().catch(() => null));
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (parsed.ids.length === 0) return NextResponse.json({ avatars: {} });

    const { data: contacts, error } = await ctx.supabase
      .from('contacts')
      .select('id, phone, avatar_url, avatar_checked_at')
      .in('id', parsed.ids);
    if (error) {
      console.error('[contacts/avatars] contact lookup failed:', error);
      return NextResponse.json(
        { error: 'Failed to load contacts' },
        { status: 500 }
      );
    }

    const now = new Date();
    const due = (contacts ?? []).filter(
      (c) => c.phone && isAvatarDue(c.avatar_checked_at, now)
    );
    if (due.length === 0) return NextResponse.json({ avatars: {} });

    const admin = supabaseAdmin();
    const channels = await loadChannels(admin, ctx.accountId);
    if (!pickAvatarChannel(channels, null)) {
      // No connected Whapi number: Meta has no picture to give.
      return NextResponse.json({ avatars: {} });
    }

    // Which number each thread is on. One conversation per contact, read
    // through RLS like the contacts themselves.
    const { data: convs } = await ctx.supabase
      .from('conversations')
      .select('contact_id, channel_id')
      .in(
        'contact_id',
        due.map((c) => c.id)
      );
    const threadChannel = new Map<string, string | null>();
    for (const c of convs ?? []) threadChannel.set(c.contact_id, c.channel_id);

    // A contact with no usable number (a Meta thread, a down Whapi
    // number) is skipped: no write, nothing in the response.
    const gate = createChannelGate(probeChannel);
    const results = await mapWithConcurrency(
      due,
      AVATAR_CONCURRENCY,
      async (contact) => {
        const channel = pickAvatarChannel(
          channels,
          threadChannel.get(contact.id)
        );
        // One live health probe per channel per request; a bad token is
        // a 404 on the profile endpoint, the same as "no picture".
        if (!channel || !(await gate(channel))) return null;
        return refreshContactAvatar({
          db: admin,
          storage: admin.storage,
          accountId: ctx.accountId,
          contactId: contact.id,
          phone: contact.phone,
          channel,
        });
      }
    );

    const avatars: Record<string, string | null> = {};
    for (const r of results) {
      if (r && (r.status === 'updated' || r.status === 'none')) {
        avatars[r.contactId] = r.avatarUrl;
      }
    }
    return NextResponse.json({ avatars });
  } catch (err) {
    return toErrorResponse(err);
  }
}
