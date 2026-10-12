// ============================================================
// GET /api/whatsapp/channels — every connected WhatsApp number, with
// its name and who it is allocated to. Backs Settings → Numbers.
//
// Allocation comes in two parts (migration 071): `member_ids` is the
// people ticked by hand, `team_ids` the teams allocated to the number,
// and `team_member_ids` the people who have it through one of those
// teams (members and leaders, kept current by triggers). A number is
// shared only when both people lists are empty.
//
// Admin-only, like the rest of the WhatsApp settings. Credentials are
// never selected, let alone returned — this is also why it reads the
// table directly instead of going through `loadChannels`, which
// decrypts every token and would fail the whole list over one row
// saved under a rotated ENCRYPTION_KEY.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

interface ChannelListRow {
  id: string;
  provider: 'whapi' | 'meta';
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  is_primary: boolean;
  status: string;
  registered_at: string | null;
  created_at: string | null;
}

interface AllocationRow {
  config_id: string;
  user_id: string;
  direct: boolean;
  via_team: boolean;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const [channelsRes, membersRes, teamsRes, profilesRes] = await Promise.all([
      supabase
        .from('whatsapp_config')
        .select(
          'id, provider, label, phone_number_id, waba_id, is_primary, status, registered_at, created_at'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: true }),
      supabase
        .from('whatsapp_channel_members')
        .select('config_id, user_id, direct, via_team')
        .eq('account_id', accountId),
      supabase
        .from('whatsapp_channel_teams')
        .select('config_id, team_id')
        .eq('account_id', accountId),
      // Staff only: a bank guest is never a number's user.
      supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .neq('account_role', 'bank_guest'),
    ]);

    // All four or nothing: a missing roster would read as "nobody is
    // allocated", and saving that back would silently un-allocate
    // everyone. The same goes for the team list.
    if (
      channelsRes.error ||
      membersRes.error ||
      teamsRes.error ||
      profilesRes.error
    ) {
      console.error(
        '[whatsapp/channels] load failed:',
        channelsRes.error ??
          membersRes.error ??
          teamsRes.error ??
          profilesRes.error
      );
      return NextResponse.json(
        { error: 'Failed to load WhatsApp numbers' },
        { status: 500 }
      );
    }

    const rows = (channelsRes.data ?? []) as ChannelListRow[];
    // Only people still on the account. An allocation row outlives a
    // member who was moved off it (the FK is to auth.users); it grants
    // nothing — can_view_* checks membership first — but listing it
    // would show a ghost, and sending it back on save would be rejected
    // as "not a member of this account".
    const current = new Set(
      (profilesRes.data ?? []).map((p) => p.user_id as string)
    );
    const push = (map: Map<string, string[]>, key: string, id: string) => {
      const list = map.get(key) ?? [];
      list.push(id);
      map.set(key, list);
    };
    // One row per person; a person can hold it both ways at once, and
    // each list says only how. Saving `member_ids` back sets the direct
    // list alone (set_channel_members), so a team's people must never
    // leak into it — they would stay after the team was taken off.
    const directByChannel = new Map<string, string[]>();
    const viaTeamByChannel = new Map<string, string[]>();
    for (const m of (membersRes.data ?? []) as AllocationRow[]) {
      if (!current.has(m.user_id)) continue;
      if (m.direct) push(directByChannel, m.config_id, m.user_id);
      if (m.via_team) push(viaTeamByChannel, m.config_id, m.user_id);
    }
    const teamsByChannel = new Map<string, string[]>();
    for (const t of teamsRes.data ?? []) {
      push(teamsByChannel, t.config_id as string, t.team_id as string);
    }

    // How many chats sit on each number — the admin's sense of scale
    // before allocating or disconnecting it. One head-count per number;
    // an account has a handful.
    const counts = await Promise.all(
      rows.map((r) =>
        supabase
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('channel_id', r.id)
          .then(({ count }) => count ?? 0)
      )
    );

    return NextResponse.json({
      channels: rows.map((r, i) => ({
        ...r,
        member_ids: directByChannel.get(r.id) ?? [],
        team_ids: teamsByChannel.get(r.id) ?? [],
        team_member_ids: viaTeamByChannel.get(r.id) ?? [],
        conversation_count: counts[i],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
