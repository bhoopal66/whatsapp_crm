// ============================================================
// PATCH /api/whatsapp/channels/[id] — rename a number, set who it is
// allocated to, or make it the account default.
//
// Body (every field optional):
//   { label?: string, member_ids?: string[], team_ids?: string[],
//     expected_member_ids?, expected_team_ids?: the lists the screen
//     showed, is_primary?: true }
//
// Admin-only. Connecting and disconnecting stay on the provider routes
// (`/api/whatsapp/config`, `/api/whatsapp/config/meta`), which own the
// credential checks; this route only edits what is shared by both.
//
// Allocation is replaced wholesale, like team membership. `member_ids`
// is the people ticked by hand and `team_ids` the teams whose members
// and leaders get the number through the team (migration 071); each
// list replaces only itself, and both are saved in one transaction
// (set_channel_access). With both sent
// empty the number is shared again (314: nothing else reopens it). What allocation MEANS is enforced in the database (migrations
// 060 and 071); this route only decides what to write.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isBankGuest } from '@/lib/auth/roles';
import {
  normalizeChannelLabel,
  validateIdList,
  validateMemberIds,
} from '@/lib/whatsapp/channel-management';
import { personalNumberRefusal } from '@/lib/whatsapp/personal-numbers';

const TEAM_NOT_IN_ACCOUNT = 'Every team allocated must belong to this account';

// set_channel_access's 22023 refusals, by hint.
const INVALID_ALLOCATION: Record<string, string> = {
  member_not_in_account: 'Everyone allocated must be a member of this account',
  team_not_in_account: TEAM_NOT_IN_ACCOUNT,
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    // Confirm the number is in this account before touching anything —
    // a cross-account write would otherwise read as "0 rows updated".
    const { data: channel, error: findError } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findError || !channel) {
      return NextResponse.json(
        { error: 'WhatsApp number not found' },
        { status: 404 }
      );
    }

    // Validate everything before writing anything.
    let label: string | undefined;
    if ('label' in body) {
      const result = normalizeChannelLabel(body.label);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      label = result.label;
    }

    let memberIds: string[] | undefined;
    if ('member_ids' in body) {
      // Staff only, filtered below rather than in the query: a database
      // without migration 082 rejects the `bank_guest` literal.
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', accountId);
      if (profilesError) {
        console.error('[whatsapp/channels] roster load failed:', profilesError);
        return NextResponse.json(
          { error: 'Failed to update WhatsApp number' },
          { status: 500 }
        );
      }
      const result = validateMemberIds(
        body.member_ids,
        new Set(
          (profiles ?? [])
            .filter((p) => !isBankGuest(p.account_role))
            .map((p) => p.user_id as string)
        )
      );
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      memberIds = result.ids;
    }

    let teamIds: string[] | undefined;
    if ('team_ids' in body) {
      const result = validateIdList(body.team_ids, 'team_ids');
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      // Checked here as well as in set_channel_access so a bad id is
      // refused before the rename is written.
      if (result.ids.length > 0) {
        const { data: teams, error: teamsError } = await supabase
          .from('teams')
          .select('id')
          .eq('account_id', accountId);
        if (teamsError) {
          console.error('[whatsapp/channels] team list failed:', teamsError);
          return NextResponse.json(
            { error: 'Failed to update WhatsApp number' },
            { status: 500 }
          );
        }
        const known = new Set((teams ?? []).map((t) => t.id as string));
        if (result.ids.some((teamId) => !known.has(teamId))) {
          return NextResponse.json(
            { error: TEAM_NOT_IN_ACCOUNT },
            { status: 400 }
          );
        }
      }
      teamIds = result.ids;
    }

    // The lists the screen showed (314), compared under the lock.
    const expected: { members: string[] | null; teams: string[] | null } = {
      members: null,
      teams: null,
    };
    for (const [key, field, sent] of [
      ['members', 'expected_member_ids', memberIds],
      ['teams', 'expected_team_ids', teamIds],
    ] as const) {
      if (!sent || !(field in body)) continue;
      const result = validateIdList(body[field], field);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      expected[key] = result.ids;
    }

    if (body.is_primary !== undefined && body.is_primary !== true) {
      return NextResponse.json(
        {
          error:
            'is_primary can only be set to true — make another number the default instead',
        },
        { status: 400 }
      );
    }

    if (label !== undefined) {
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ label, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId);
      if (error) {
        console.error('[whatsapp/channels] rename failed:', error);
        return NextResponse.json(
          { error: 'Failed to rename WhatsApp number' },
          { status: 500 }
        );
      }
    }

    if (memberIds !== undefined || teamIds !== undefined) {
      // One transaction (migration 071): the people and the teams are
      // saved together or not at all. As two requests, a refused team
      // list after the people were cleared could leave the number shared
      // with everyone. NULL leaves that list unchanged.
      const { error } = await supabase.rpc('set_channel_access', {
        p_config_id: id,
        p_user_ids: memberIds ?? null,
        p_team_ids: teamIds ?? null,
        ...(expected.members || expected.teams
          ? {
              p_expected_user_ids: expected.members,
              p_expected_team_ids: expected.teams,
            }
          : {}),
      });
      if (error) {
        console.error('[whatsapp/channels] allocate failed:', error);
        const refusal = personalNumberRefusal(error);
        if (refusal) return refusal;
        if (error.code === 'P0002') {
          return NextResponse.json(
            { error: 'WhatsApp number not found' },
            { status: 404 }
          );
        }
        if (error.code === '22023' && error.hint === 'access_changed') {
          return NextResponse.json(
            {
              error: 'Who may use this number was changed meanwhile',
              code: 'access_changed',
            },
            { status: 409 }
          );
        }
        if (error.code === '22023') {
          return NextResponse.json(
            {
              error:
                INVALID_ALLOCATION[error.hint ?? ''] ??
                'Failed to update who works this number',
            },
            { status: 400 }
          );
        }
        return NextResponse.json(
          { error: 'Failed to update who works this number' },
          { status: 500 }
        );
      }
    }

    if (body.is_primary === true) {
      // Demote-then-promote in one transaction (062): the account is
      // never left without a default, even for a moment.
      const { error } = await supabase.rpc('set_primary_channel', {
        p_config_id: id,
      });
      if (error) {
        console.error('[whatsapp/channels] set default failed:', error);
        const refusal = personalNumberRefusal(error);
        if (refusal) return refusal;
        return NextResponse.json(
          { error: 'Failed to make this the default number' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
