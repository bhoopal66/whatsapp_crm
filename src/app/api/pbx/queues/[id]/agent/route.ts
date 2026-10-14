// ============================================================
// POST /api/pbx/queues/[id]/agent — log a queue agent in or out, or
// pause or resume them, as the Linkus app's Queues tab does.
// { action: 'login'|'logout'|'pause'|'unpause', extension? } → { ok }.
//
// No extension, or the caller's own: the caller acts on themselves
// (agent/login, agent/pause, for this queue only), which needs an
// extension of their own. Another extension: team leader and up only
// (403 otherwise), and it must be mapped to a person in the caller's
// workspace (404 otherwise, so another workspace's extensions on a
// shared PBX are out of reach); queue/agent_login or queue/agent_pause.
// The queue must exist (404 queue_not_found) and list the extension
// (409 not_in_queue); a static agent cannot log in or out (409
// static_agent). A pause reason is never sent: below the Enterprise /
// Ultimate plans the PBX fails the whole request. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { fail, jsonObject, noExtension, pbxFailure } from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import { groupsConnection, workspaceExtensions } from '@/lib/pbx/groups-server';

const ACTIONS = ['login', 'logout', 'pause', 'unpause'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (v: unknown): v is Action =>
  typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: rawId } = await context.params;
    const queueId = /^[1-9]\d{0,9}$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(queueId)) return fail('Invalid queue id');
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    if (!isAction(b.action))
      return fail(`action must be one of ${ACTIONS.join(', ')}`);
    const action = b.action;
    if (
      b.extension !== undefined &&
      !(
        typeof b.extension === 'string' &&
        b.extension.trim() !== '' &&
        b.extension.trim().length <= 32
      )
    )
      return fail('extension must be an extension number');
    const asked =
      typeof b.extension === 'string' ? b.extension.trim() : undefined;

    const conn = await groupsConnection(ctx);
    const self = !asked || asked === conn?.myExtension;
    if (!self && !hasMinRole(ctx.role, 'team_leader'))
      return fail('Only a team leader can act on another agent', 403);
    const target = self ? conn?.myExtension : asked;
    if (!conn || !target) return noExtension();

    if (!self) {
      const mapped = await workspaceExtensions(
        ctx.supabase,
        ctx.accountId,
        conn.connectionId
      );
      if (!mapped.has(target))
        return fail('No one in this workspace has that extension', 404, {
          code: 'extension_not_found',
        });
    }

    const { api } = await pbxApiFor(pbxServiceDb(), conn.connectionId);
    const queue = (await api.listQueues()).find((q) => q.id === queueId);
    if (!queue)
      return fail('The phone system has no such queue', 404, {
        code: 'queue_not_found',
      });
    const dynamicAgent = queue.dynamicAgents.find((a) => a.number === target);
    const agent =
      dynamicAgent ?? queue.staticAgents.find((a) => a.number === target);
    if (!agent)
      return fail('That extension is not an agent of this queue', 409, {
        code: 'not_in_queue',
      });
    const login = action === 'login' || action === 'logout';
    if (login && !dynamicAgent)
      return fail('A static agent is always logged in to its queue', 409, {
        code: 'static_agent',
      });

    const extId = agent.extId ?? (await api.findExtension(target))?.id;
    if (!extId)
      return fail('The phone system does not list that extension', 409, {
        code: 'extension_not_on_pbx',
      });

    if (action === 'login' || action === 'logout') {
      if (self)
        await api.agentLogin({ extId, operation: action, queueIds: [queueId] });
      else
        await api.managerAgentLogin({
          extIds: [extId],
          queueId,
          operation: action,
        });
    } else if (self) {
      await api.agentPause({ extId, operation: action, queueIds: [queueId] });
    } else {
      await api.managerAgentPause({
        extIds: [extId],
        queueId,
        operation: action,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
