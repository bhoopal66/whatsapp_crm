// ============================================================
// GET /api/pbx/groups — the PBX's ring groups and queues, as the Linkus
// app's Groups and Queues tabs show them, with each queue agent's live
// state (queue/agent_status). Agent+.
//
// The PBX is the caller's own extension's; a team leader or above with
// no extension sees the workspace's. Only groups and queues with at
// least one member mapped to a person in the caller's workspace are
// shown: on a PBX shared between workspaces the rest are another
// workspace's set-up. A shown group still lists its unmapped members,
// with userId and name null. Live state is read for at most
// MAX_QUEUES queues (the caller's own first), MAX_CONCURRENT at a time;
// the rest are left out and queuesTruncated says so.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { noExtension, pbxFailure } from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import {
  groupsConnection,
  mapLimit,
  queueCallStatus,
  workspaceExtensions,
  type MappedPerson,
  type QueueCallStatus,
} from '@/lib/pbx/groups-server';

const MAX_QUEUES = 30;
const MAX_CONCURRENT = 5;

interface Member {
  extension: string;
  userId: string | null;
  name: string | null;
}

interface Agent extends Member {
  static: boolean;
  loggedIn: boolean;
  paused: boolean;
  callStatus: QueueCallStatus;
}

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const conn = await groupsConnection(ctx);
    if (!conn) return noExtension();

    const [{ api }, mapped] = await Promise.all([
      pbxApiFor(pbxServiceDb(), conn.connectionId),
      workspaceExtensions(ctx.supabase, ctx.accountId, conn.connectionId),
    ]);
    const member = (extension: string): Member => {
      const p: MappedPerson | undefined = mapped.get(extension);
      return { extension, userId: p?.userId ?? null, name: p?.name ?? null };
    };

    const [groups, queues] = await Promise.all([
      api.listRingGroups(),
      api.listQueues(),
    ]);

    const ringGroups = groups
      .map((g) => ({
        id: g.id,
        number: g.number,
        name: g.name,
        strategy: g.strategy,
        members: g.members.map((m) => member(m.number)),
      }))
      .filter((g) => g.members.some((m) => m.userId));

    const visible = queues
      .map((q) => {
        const agents: (Member & { static: boolean })[] = [];
        for (const [list, isStatic] of [
          [q.dynamicAgents, false],
          [q.staticAgents, true],
        ] as const)
          for (const a of list)
            if (!agents.some((x) => x.extension === a.number))
              agents.push({ ...member(a.number), static: isStatic });
        return { id: q.id, number: q.number, name: q.name, agents };
      })
      .filter((q) => q.agents.some((a) => a.userId));
    const mine = (q: (typeof visible)[number]) =>
      q.agents.some((a) => a.extension === conn.myExtension);
    const shown = [
      ...visible.filter(mine),
      ...visible.filter((q) => !mine(q)),
    ].slice(0, MAX_QUEUES);

    const withStatus = await mapLimit(shown, MAX_CONCURRENT, async (q) => {
      const status = new Map(
        (await api.queueAgentStatus(q.id)).map((s) => [s.number, s])
      );
      const agents: Agent[] = q.agents.map((a) => {
        const s = status.get(a.extension);
        return {
          ...a,
          loggedIn: s?.loggedIn ?? false,
          paused: s?.paused ?? false,
          callStatus: queueCallStatus(s?.callStatus ?? 0),
        };
      });
      return { ...q, agents };
    });

    return NextResponse.json({
      myExtension: conn.myExtension,
      canManage: hasMinRole(ctx.role, 'team_leader'),
      ringGroups,
      queues: withStatus,
      queuesTruncated: visible.length > MAX_QUEUES,
    });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
