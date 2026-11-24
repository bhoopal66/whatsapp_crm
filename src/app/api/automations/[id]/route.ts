import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  requireRole,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  flattenSteps,
  loadStepsTree,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';
import { templateValueIssues } from '@/lib/automations/template-issues';
import { serverErrorResponse } from '@/lib/api/server-error';
import {
  AuthUnavailableError,
  isAuthUnavailable,
} from '@/lib/auth/auth-unavailable';

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (isAuthUnavailable(authError)) throw new AuthUnavailableError();
  return user;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Admin+ to READ as well as write: this is an admin-only screen, and
  // the payload describes how the account's messaging behaves.
  // The caller's CURRENT account. Scoping by creator alone let a
  // member who was removed from the account (and so moved into a
  // personal one) keep editing what they wrote here.
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = supabaseAdmin();
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();

  if (error)
    return serverErrorResponse('GET /api/automations/[id]', error);
  if (!automation)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const steps = await loadStepsTree(id);
  return NextResponse.json({ automation, steps });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce the role here.
  // The caller's CURRENT account. Scoping by creator alone let a
  // member who was removed from the account (and so moved into a
  // personal one) keep editing what they wrote here.
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, user_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  // Any admin of the account may edit any of its automations — the
  // list (GET /api/automations) already shows them all under RLS.
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k];
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean'
      ? update.is_active
      : existing.is_active;
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ??
      existing.trigger_type) as string;
    const mergedTriggerConfig =
      update.trigger_config ?? existing.trigger_config;
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[])
      : await loadStepsTree(id);
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
      ...(await templateValueIssues(admin, ctx.accountId, mergedSteps)),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 }
      );
    }
  }

  // One transaction: the row, its steps (in place by id, so a parked run
  // still finds its wait) and the check that nobody saved in between.
  const { data: saved, error: saveErr } = await admin.rpc('automation_save', {
    p_account_id: ctx.accountId,
    p_automation_id: id,
    // Sent by the builder. The list's on/off switch and an older tab send
    // none and are not checked.
    p_expected_updated_at:
      typeof body.updated_at === 'string' ? body.updated_at : null,
    p_patch: update,
    p_steps: Array.isArray(body.steps)
      ? flattenSteps(id, body.steps as BuilderStepInput[], { keepIds: true })
      : null,
  });
  if (saveErr) return serverErrorResponse('PATCH /api/automations/[id]', saveErr);
  const outcome = saved as { status: string; updated_at?: string } | null;
  if (outcome?.status === 'not_found')
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (outcome?.status === 'conflict')
    return NextResponse.json(
      {
        error:
          'Someone else changed this automation since you opened it. Reload the page before saving.',
      },
      { status: 409 }
    );

  return NextResponse.json({ ok: true, updated_at: outcome?.updated_at });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  // The caller's CURRENT account. Scoping by creator alone let a
  // member who was removed from the account (and so moved into a
  // personal one) keep editing what they wrote here.
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = assertSalesAccess(await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error)
    return serverErrorResponse('DELETE /api/automations/[id]', error);
  return NextResponse.json({ ok: true });
}
