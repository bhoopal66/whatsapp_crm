import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { adminChannelList } from '@/lib/chat/admin-tools';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/**
 * GET /api/chat/admin/private-channels — the private channels, DMs and
 * deal rooms of the caller's workspace that the caller is NOT in, for
 * Settings → Team chat's audited read (owner/admin).
 *
 * RLS hides exactly these rows from a non-member admin, so the list is
 * read with the service role. It carries labels, member counts and the
 * last activity only, never a message: reading one is
 * chat_admin_read_private, which writes chat_audit_log first.
 */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const admin = supabaseAdmin();

    // message_pins (channel_id, message_id) is a second path from a
    // channel to its messages, so an unnamed internal_messages embed is
    // ambiguous to PostgREST (PGRST201, answered as HTTP 300) and this
    // list never loaded: name the direct foreign key.
    const [channels, people] = await Promise.all([
      admin
        .from('chat_channels')
        .select(
          'id, kind, name, archived_at, created_at, members:chat_channel_members(user_id), internal_messages!internal_messages_channel_id_fkey(created_at)'
        )
        .eq('account_id', ctx.accountId)
        .in('kind', ['private', 'dm', 'deal_room'])
        .order('created_at', {
          referencedTable: 'internal_messages',
          ascending: false,
        })
        .limit(1, { referencedTable: 'internal_messages' }),
      // Deactivated people too: their DMs are still there to read.
      admin
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', ctx.accountId),
    ]);
    if (channels.error || people.error) {
      console.error(
        '[GET /api/chat/admin/private-channels] read failed:',
        channels.error ?? people.error
      );
      return NextResponse.json(
        { error: 'Failed to load private channels' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      channels: adminChannelList(
        (channels.data ?? []) as Record<string, unknown>[],
        ctx.userId,
        people.data ?? []
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
