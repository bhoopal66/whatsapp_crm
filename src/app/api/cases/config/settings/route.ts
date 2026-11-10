// ============================================================
// /api/cases/config/settings — Settings -> Cases: the account's case
// settings (migrations 134, 136). GET (agent and up, the caller's RLS
// client): `{ settings: { managedExternally, submissionWhatsappGroups } }`,
// each false when never saved. PUT (owner / admin) takes
// `{ managed_externally?: boolean, submission_whatsapp_groups?: boolean }`
// (at least one; each sent key must be a boolean) and answers the same
// shape with both stored values, through case_settings_set /
// case_settings_set_whatsapp_groups on the service role (granted only
// there; each re-checks the writer: NOT_ALLOWED). The account is the
// caller's active one, never a body value.
//
// Case document files (migration 181): GET also answers `caseFiles:
// { checklistSync, readyMove, readyFromStage, readyToStage,
// intakePrompts }` (case_files_settings, service role; off / null by
// default). PUT also takes `caseFiles` in that shape, every key optional:
// each switch sent goes through case_settings_set_files_switch, and
// `readyFromStage` + `readyToStage` (sent together; both null clears)
// through case_settings_set_files_ready_stages once (SETTING_INVALID ->
// 422). A PUT that sent `caseFiles` answers `caseFiles` as stored too.
// The writes are separate calls, not one transaction.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  caseFilesErrorResponse,
  parseCaseFilesSettings,
} from '@/lib/case-files/http';
import {
  CaseFilesRefusedError,
  CaseFilesStore,
  CaseFilesStoreError,
} from '@/lib/case-files/store';
import { configErrorResponse, readRows } from '@/lib/cases/config-http';
import { badRequest, readObject } from '@/lib/cases/http';
import { fail } from '@/lib/cases/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

function errorResponse(err: unknown, route: string) {
  return err instanceof CaseFilesRefusedError ||
    err instanceof CaseFilesStoreError
    ? caseFilesErrorResponse(err, route)
    : configErrorResponse(err, route);
}

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const [[row], caseFiles] = await Promise.all([
      readRows(
        ctx.supabase
          .from('case_account_settings')
          .select('managed_externally, submission_whatsapp_groups')
          .eq('account_id', ctx.accountId)
          .limit(1),
        'case_account_settings'
      ),
      // Soft: a failed case-files read leaves caseFiles null (that card
      // shows it could not load) and never blanks the older switches.
      new CaseFilesStore(supabaseAdmin()).settings(ctx.accountId).catch(() => {
        console.error('[cases settings] case files settings read failed');
        return null;
      }),
    ]);
    return NextResponse.json({
      settings: {
        managedExternally: row?.managed_externally === true,
        submissionWhatsappGroups: row?.submission_whatsapp_groups === true,
      },
      caseFiles,
    });
  } catch (err) {
    return errorResponse(err, 'settings GET');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readObject(request);
    const managed = body.managed_externally;
    const groups = body.submission_whatsapp_groups;
    const files = parseCaseFilesSettings(body.caseFiles);
    if (managed === undefined && groups === undefined && !files)
      throw badRequest(
        'managed_externally, submission_whatsapp_groups or caseFiles is required'
      );
    if (managed !== undefined && typeof managed !== 'boolean')
      throw badRequest('managed_externally must be true or false');
    if (groups !== undefined && typeof groups !== 'boolean')
      throw badRequest('submission_whatsapp_groups must be true or false');
    const db = supabaseAdmin();
    if (managed !== undefined) {
      const { error } = await db.rpc('case_settings_set', {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_managed_externally: managed,
      });
      if (error) fail('case_settings_set', error);
    }
    if (groups !== undefined) {
      const { error } = await db.rpc('case_settings_set_whatsapp_groups', {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_on: groups,
      });
      if (error) fail('case_settings_set_whatsapp_groups', error);
    }
    const store = new CaseFilesStore(db);
    for (const [which, on] of files?.switches ?? [])
      await store.setSwitch(ctx.userId, ctx.accountId, which, on);
    if (files?.stages)
      await store.setReadyStages(
        ctx.userId,
        ctx.accountId,
        files.stages.from,
        files.stages.to
      );
    // Both values as stored (a key not sent is read back, not assumed).
    const [{ data: m, error: me }, { data: g, error: ge }, caseFiles] =
      await Promise.all([
        db.rpc('case_managed_externally', { p_account: ctx.accountId }),
        db.rpc('case_submission_whatsapp_groups', {
          p_account: ctx.accountId,
        }),
        files ? store.settings(ctx.accountId) : null,
      ]);
    if (me) fail('case_managed_externally', me);
    if (ge) fail('case_submission_whatsapp_groups', ge);
    return NextResponse.json({
      settings: {
        managedExternally: m === true,
        submissionWhatsappGroups: g === true,
      },
      ...(caseFiles ? { caseFiles } : {}),
    });
  } catch (err) {
    return errorResponse(err, 'settings PUT');
  }
}
