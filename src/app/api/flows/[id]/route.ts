import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  requireRole,
  toErrorResponse,
  assertSalesAccess,
  type AccountContext,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { flowVersion } from '@/lib/flows/save-request';
import type { FlowRow } from '@/lib/flows/types';
import { validateFlowForActivation } from '@/lib/flows/validate';
import { serverErrorResponse } from '@/lib/api/server-error';
import {
  AuthUnavailableError,
  isAuthUnavailable,
} from '@/lib/auth/auth-unavailable';

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes.
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph, in one transaction
 *                          (`flow_save`, 300): 409 when somebody saved it
 *                          since `expected`, 422 when the flow is active
 *                          and what would be saved does not validate.
 * DELETE /api/flows/[id] — hard delete (RLS+CASCADE clean up nodes,
 *                          runs, events).
 *
 * All three require a signed-in caller who owns the flow. Flows is in
 * soft-GA — the beta gate that previously 404'd non-beta accounts is
 * gone; the "Beta" label in the UI is the only remaining signal.
 */

async function requireOwnership(flowId: string): Promise<
  | {
      ok: true;
      userId: string;
      supabase: Awaited<ReturnType<typeof createClient>>;
    }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (isAuthUnavailable(authError)) {
    return {
      ok: false,
      status: 503,
      body: { error: new AuthUnavailableError().message },
    };
  }
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  // RLS scopes this to the caller — a flow owned by another user
  // returns null (404 below).
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle();
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } };
  }
  return { ok: true, userId: user.id, supabase };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Admin+ to READ as well as write: this is an admin-only screen, and
  // the payload describes how the account's messaging behaves.
  try {
    assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });
  const { supabase } = guard;

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ]);
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ flow, nodes: nodes ?? [] });
}

interface PutBody {
  name?: string;
  description?: string | null;
  trigger_type?: FlowRow['trigger_type'];
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  fallback_policy?: Record<string, unknown>;
  nodes?: Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
    position_x?: number;
    position_y?: number;
  }>;
  /** The version the editor loaded (`flowVersion`); absent is unchecked. */
  expected?: string;
}

/** Who saved the flow after the caller loaded it, and when. */
async function changedResponse(ctx: AccountContext, id: string) {
  const { data: flow } = await ctx.supabase
    .from('flows')
    .select('edited_at, edited_by, created_at')
    .eq('id', id)
    .maybeSingle();
  if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { data: who } = flow.edited_by
    ? await ctx.supabase
        .from('profiles')
        .select('full_name')
        .eq('user_id', flow.edited_by)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
    : { data: null };
  const version = flowVersion(flow);
  return NextResponse.json(
    {
      error: `Somebody else saved this flow at ${version}; reload to see it`,
      changed: { version, at: version, by: who?.full_name || null },
    },
    { status: 409 }
  );
}

/** The separate writes, for a database where `flow_save` does not exist. */
async function saveBefore300(
  admin: ReturnType<typeof supabaseAdmin>,
  id: string,
  patch: Record<string, unknown>,
  nodes: PutBody['nodes']
) {
  const { error: updErr } = await admin
    .from('flows')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr || nodes === undefined) return updErr;
  const { error: delErr } = await admin
    .from('flow_nodes')
    .delete()
    .eq('flow_id', id);
  if (delErr || nodes.length === 0) return delErr;
  const { error: insErr } = await admin.from('flow_nodes').insert(
    nodes.map((n) => ({
      flow_id: id,
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config,
      position_x: n.position_x ?? 0,
      position_y: n.position_y ?? 0,
    }))
  );
  return insErr;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // RLS enforces the role on `flow_save`; the pre-300 path below writes
  // as the service role, and the department rule lives only here.
  let ctx: AccountContext;
  try {
    ctx = assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  const body = (await request.json().catch(() => null)) as PutBody | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json(
      { error: 'name cannot be empty' },
      { status: 400 }
    );
  }

  if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
    return NextResponse.json(
      { error: 'nodes must be a list' },
      { status: 400 }
    );
  }

  const { supabase } = guard;
  const admin = supabaseAdmin();

  // The body may not include `nodes` (a header-only save for editing the
  // trigger config without touching the graph): the stored ones stay.
  const flowPatch: Record<string, unknown> = {};
  if (body.name !== undefined) flowPatch.name = body.name.trim();
  if (body.description !== undefined) flowPatch.description = body.description;
  if (body.trigger_type !== undefined)
    flowPatch.trigger_type = body.trigger_type;
  if (body.trigger_config !== undefined)
    flowPatch.trigger_config = body.trigger_config;
  if (body.entry_node_id !== undefined)
    flowPatch.entry_node_id = body.entry_node_id;
  // Normalised through the same resolver the runner uses, so what is
  // stored is always a complete policy with known values.
  if (body.fallback_policy !== undefined)
    flowPatch.fallback_policy = resolveFallbackPolicy(body.fallback_policy);

  // A live flow answers customers from the moment it is saved, so it has
  // to pass what activating it would. Drafts may be incomplete.
  const { data: current, error: readErr } = await supabase
    .from('flows')
    .select('status, name, trigger_type, trigger_config, entry_node_id')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return serverErrorResponse('PUT /api/flows/[id]', readErr);
  if (current?.status === 'active') {
    let nodes = body.nodes?.map((n) => ({ ...n, config: n.config ?? {} }));
    if (!nodes) {
      const { data, error } = await supabase
        .from('flow_nodes')
        .select('node_key, node_type, config')
        .eq('flow_id', id);
      if (error) return serverErrorResponse('PUT /api/flows/[id]', error);
      nodes = data ?? [];
    }
    const merged = { ...current, ...flowPatch } as Parameters<
      typeof validateFlowForActivation
    >[0];
    const issues = validateFlowForActivation(
      { ...merged, trigger_config: merged.trigger_config ?? {} },
      nodes
    );
    if (issues.some((i) => i.severity === 'error')) {
      return NextResponse.json(
        {
          error: 'This flow is live — fix the issues below before saving.',
          issues,
        },
        { status: 422 }
      );
    }
  }

  // As the caller: RLS decides who may save.
  const { data: saved, error: saveErr } = await supabase.rpc('flow_save', {
    p_flow: id,
    p_patch: flowPatch,
    p_nodes: body.nodes ?? null,
    p_expected: typeof body.expected === 'string' ? body.expected : null,
  });
  if (saveErr) {
    if (saveErr.hint === 'FLOW_CHANGED') return changedResponse(ctx, id);
    if (saveErr.hint === 'FLOW_NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (saveErr.hint === 'FLOW_DUPLICATE_KEY') {
      return NextResponse.json(
        { error: `Two steps have the key "${saveErr.details}"` },
        { status: 400 }
      );
    }
    // Only a database without 300 gets the separate writes.
    if (saveErr.code !== 'PGRST202' && saveErr.code !== '42883') {
      return serverErrorResponse('PUT /api/flows/[id]', saveErr);
    }
    const oldErr = await saveBefore300(admin, id, flowPatch, body.nodes);
    if (oldErr) return serverErrorResponse('PUT /api/flows/[id]', oldErr);
  }

  // Re-fetch and return the new state — the editor uses the response
  // to reconcile its local form state.
  const [{ data: flow }, { data: nodes }] = await Promise.all([
    admin.from('flows').select('*').eq('id', id).maybeSingle(),
    admin
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ]);
  // The version of THIS save: the re-read may already be somebody else's.
  return NextResponse.json({
    flow,
    nodes: nodes ?? [],
    version: (saved as { edited_at?: string } | null)?.edited_at ?? null,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Writes require at least `agent` — see the PUT handler note. The
  // service-role client below bypasses the agent-gated flows_delete RLS.
  try {
    assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
  // children. Active runs end abruptly — there's no graceful "drain"
  // mechanism in v1, but that's intentional: deleting a flow is a
  // deliberate destructive action and the partial unique index will
  // free up the contact for new triggers immediately.
  const { error } = await supabaseAdmin().from('flows').delete().eq('id', id);
  if (error) {
    return serverErrorResponse('DELETE /api/flows/[id]', error);
  }
  return NextResponse.json({ ok: true });
}
