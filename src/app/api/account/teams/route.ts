// ============================================================
// GET  /api/account/teams   — list teams with leader + members
// POST /api/account/teams   — create a team
//
// Teams are an admin construct: admins create them, appoint a leader
// and staff them. A leader's powers follow from being named here —
// they see their team's chats and contacts, and can move work between
// the people they lead (migration 044).
//
// Each team also carries `channel_ids`: the WhatsApp numbers allocated
// to it (migration 071), which its members and leader work.
//
// The whole roster is admin-only, matching Settings -> Teams. Names of
// teams are not secret, but nothing below admin has a use for the list.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

/** Mirrors the unique index on (account_id, lower(name)). */
const MAX_NAME_LEN = 60;

interface TeamRow {
  id: string;
  name: string;
  leader_user_id: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const [
      { data: teams, error: teamsError },
      { data: members, error: membersError },
      { data: channels, error: channelsError },
    ] = await Promise.all([
        ctx.supabase
          .from('teams')
          .select('id, name, leader_user_id, created_at')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: true }),
        ctx.supabase
          .from('team_members')
          .select('team_id, user_id')
          .eq('account_id', ctx.accountId),
        ctx.supabase
          .from('whatsapp_channel_teams')
          .select('team_id, config_id')
          .eq('account_id', ctx.accountId),
      ]);

    // All or nothing, as on the numbers list: a missing allocation list
    // would read as "no numbers", and saving it back would clear them.
    if (teamsError || membersError || channelsError) {
      console.error(
        '[GET /api/account/teams] fetch error:',
        teamsError ?? membersError ?? channelsError,
      );
      return NextResponse.json({ error: 'Failed to load teams' }, { status: 500 });
    }

    // Fold membership onto each team here rather than making the client
    // do it — the Teams panel only ever wants them together.
    const byTeam = new Map<string, string[]>();
    for (const m of (members ?? []) as { team_id: string; user_id: string }[]) {
      const list = byTeam.get(m.team_id) ?? [];
      list.push(m.user_id);
      byTeam.set(m.team_id, list);
    }

    const channelsByTeam = new Map<string, string[]>();
    for (const c of (channels ?? []) as { team_id: string; config_id: string }[]) {
      const list = channelsByTeam.get(c.team_id) ?? [];
      list.push(c.config_id);
      channelsByTeam.set(c.team_id, list);
    }

    return NextResponse.json({
      teams: ((teams ?? []) as TeamRow[]).map((t) => ({
        ...t,
        member_ids: byTeam.get(t.id) ?? [],
        channel_ids: channelsByTeam.get(t.id) ?? [],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    // `?? {}`: a body of `null` parses fine and then threw on `.name`.
    const body = (await request.json().catch(() => null)) ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!name) {
      return NextResponse.json({ error: 'A team name is required' }, { status: 400 });
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Team name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from('teams')
      .insert({ account_id: ctx.accountId, name })
      .select('id, name, leader_user_id, created_at')
      .single();

    if (error) {
      // 23505 = the (account_id, lower(name)) unique index.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A team with that name already exists' },
          { status: 409 },
        );
      }
      console.error('[POST /api/account/teams] insert error:', error);
      return NextResponse.json({ error: 'Failed to create the team' }, { status: 500 });
    }

    return NextResponse.json({ team: { ...data, member_ids: [], channel_ids: [] } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
