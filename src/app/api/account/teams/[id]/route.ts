// ============================================================
// PATCH  /api/account/teams/[id]  — rename, set leader, set members,
//                                   set the WhatsApp numbers it works
// DELETE /api/account/teams/[id]  — remove a team
//
// Admin-only, like the rest of Settings -> Teams.
//
// Membership is replaced wholesale rather than patched incrementally:
// the UI edits a team as one form, and replacing each list is far
// easier to reason about than a diff protocol that has to describe adds
// and removes separately. The whole form is one update_team call, so a
// refusal changes nothing.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { validateIdList } from '@/lib/whatsapp/channel-management';

const MAX_NAME_LEN = 60;

// update_team's 22023 refusals, by hint.
const INVALID_SELECTION: Record<string, string> = {
  member_not_in_account: 'Every team member must be a member of this account',
  leader_not_in_account: 'The team leader must be a member of this account',
  number_not_in_account: 'Every WhatsApp number must belong to this account',
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));

    // Shape-checked before anything is written. Whether each person and
    // number is in this account is update_team's call (22023).
    let channelIds: string[] | null = null;
    if ('channel_ids' in body) {
      const result = validateIdList(body.channel_ids, 'channel_ids');
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      channelIds = result.ids;
    }

    let name: string | null = null;
    if (typeof body.name === 'string') {
      name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: 'A team name is required' }, { status: 400 });
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Team name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
    }

    // `null` clears the leader; undefined leaves it alone. A leaderless
    // team is deliberately allowed — it is the natural state between
    // creating a team and choosing who runs it.
    const setLeader = 'leader_user_id' in body;
    const leaderUserId =
      setLeader && typeof body.leader_user_id === 'string' ? body.leader_user_id : null;

    const memberIds: string[] | null = Array.isArray(body.member_ids)
      ? [...new Set<string>(body.member_ids.filter((v: unknown): v is string => typeof v === 'string'))]
      : null;

    // One transaction (migration 071): name, leader, members and numbers
    // are saved together or not at all. As separate requests, a refused
    // member list used to leave the team EMPTY — which strips its
    // members' team-derived numbers and can make a number allocated only
    // to this team shared with everyone. NULL leaves a field alone.
    const { error } = await ctx.supabase.rpc('update_team', {
      p_team_id: id,
      p_name: name,
      p_set_leader: setLeader,
      p_leader_user_id: leaderUserId,
      p_member_ids: memberIds,
      p_config_ids: channelIds,
    });

    if (error) {
      if (error.code === 'P0002') {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      if (error.code === '23505') {
        // Say which constraint bit, because "failed to save" would send
        // an admin hunting. Anything but the name is the
        // one-team-per-person rule (hinted, or the 044 index itself).
        return NextResponse.json(
          {
            error:
              error.hint === 'team_name_taken'
                ? 'A team with that name already exists'
                : 'Someone you selected is already in another team. A person can only belong to one team.',
          },
          { status: 409 },
        );
      }
      if (error.code === '22023') {
        return NextResponse.json(
          { error: INVALID_SELECTION[error.hint ?? ''] ?? 'Failed to save the team' },
          { status: 400 },
        );
      }
      console.error('[PATCH /api/account/teams] update_team error:', error);
      return NextResponse.json({ error: 'Failed to save the team' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;

    // team_members rows go with it via ON DELETE CASCADE. Nothing else
    // references a team: conversations and contacts are owned by
    // PEOPLE, and disbanding a team only removes the leader's extra
    // view of their work — no customer data moves or disappears.
    const { error } = await ctx.supabase
      .from('teams')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[DELETE /api/account/teams] error:', error);
      return NextResponse.json({ error: 'Failed to delete the team' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
