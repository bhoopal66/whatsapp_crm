// ============================================================
// PATCH  /api/account/teams/[id]  — rename, set leader, set members
// DELETE /api/account/teams/[id]  — remove a team
//
// Admin-only, like the rest of Settings -> Teams.
//
// Membership is replaced wholesale rather than patched incrementally:
// the UI edits a team as one form, and a delete-then-insert inside a
// single request is far easier to reason about than a diff protocol
// that has to describe adds and removes separately.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

const MAX_NAME_LEN = 60;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));

    // Confirm the team is in this account before touching anything.
    // RLS would refuse a cross-account write anyway, but that surfaces
    // as "0 rows updated", which is indistinguishable from a no-op.
    const { data: team, error: findError } = await ctx.supabase
      .from('teams')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (findError || !team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: 'A team name is required' }, { status: 400 });
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Team name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    // `null` clears the leader; undefined leaves it alone. A leaderless
    // team is deliberately allowed — it is the natural state between
    // creating a team and choosing who runs it.
    if ('leader_user_id' in body) {
      patch.leader_user_id =
        typeof body.leader_user_id === 'string' ? body.leader_user_id : null;
    }

    const { error: updateError } = await ctx.supabase
      .from('teams')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (updateError) {
      if (updateError.code === '23505') {
        return NextResponse.json(
          { error: 'A team with that name already exists' },
          { status: 409 },
        );
      }
      console.error('[PATCH /api/account/teams] update error:', updateError);
      return NextResponse.json({ error: 'Failed to save the team' }, { status: 500 });
    }

    if (Array.isArray(body.member_ids)) {
      const memberIds = [
        ...new Set(body.member_ids.filter((v: unknown): v is string => typeof v === 'string')),
      ];

      const { error: clearError } = await ctx.supabase
        .from('team_members')
        .delete()
        .eq('team_id', id)
        .eq('account_id', ctx.accountId);

      if (clearError) {
        console.error('[PATCH /api/account/teams] clear members error:', clearError);
        return NextResponse.json(
          { error: 'Failed to update team members' },
          { status: 500 },
        );
      }

      if (memberIds.length > 0) {
        const { error: insertError } = await ctx.supabase.from('team_members').insert(
          memberIds.map((userId) => ({
            team_id: id,
            user_id: userId,
            account_id: ctx.accountId,
          })),
        );

        if (insertError) {
          // 23505 = the one-team-per-user index. Say which constraint
          // bit, because "failed to save" would send an admin hunting.
          if (insertError.code === '23505') {
            return NextResponse.json(
              {
                error:
                  'Someone you selected is already in another team. A person can only belong to one team.',
              },
              { status: 409 },
            );
          }
          console.error('[PATCH /api/account/teams] insert members error:', insertError);
          return NextResponse.json(
            { error: 'Failed to update team members' },
            { status: 500 },
          );
        }
      }
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
