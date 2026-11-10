// ============================================================
// /api/cases/[id]/build — the case's assembled case file (migration 182).
//
//   GET  case readers -> 200 `{ build }`: the ready build (buildId,
//        version, merged, manifest, sha256, status, builtAt) or null.
//        Never the storage object path: download goes through
//        build/download, which audits.
//   POST -> 201 `{ build }` (same shape, status 'ready'): assembles a new
//        build as the caller. 182 decides who may (403 NOT_ALLOWED) and
//        when (409 FILE_NOT_READY / CASE_CLOSED / BUILD_INVALID).
//
// Refusals are `{ error, code }` (lib/case-files/http.ts); every response
// is `Cache-Control: no-store`.
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import {
  assembleCaseFile,
  currentCaseFileBuild,
  type AssembledCaseFile,
} from '@/lib/case-files/assembly';
import { caseFilesErrorResponse, noStore } from '@/lib/case-files/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** The build as the API shows it: everything but the object path. */
function publicBuild(
  b: Omit<AssembledCaseFile, 'objectPath'> & {
    status: 'ready' | 'superseded';
    builtAt: Date;
  }
) {
  return {
    buildId: b.buildId,
    version: b.version,
    merged: b.merged,
    manifest: b.manifest,
    sha256: b.sha256,
    status: b.status,
    builtAt: b.builtAt.toISOString(),
  };
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const build = await currentCaseFileBuild({
      admin: supabaseAdmin(),
      actor: ctx.userId,
      caseId: c.id,
    });
    return noStore(
      NextResponse.json({ build: build ? publicBuild(build) : null })
    );
  } catch (err) {
    return noStore(caseFilesErrorResponse(err, 'build read'));
  }
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const admin = supabaseAdmin();
    const now = new Date();
    // internalBaseUrl is left to its default, serverSupabaseUrl(), as the
    // upload and attach routes do.
    const built = await assembleCaseFile({
      admin,
      actor: ctx.userId,
      caseId: c.id,
      deps: { storage: admin.storage },
      now,
    });
    return noStore(
      NextResponse.json(
        {
          build: publicBuild({ ...built, status: 'ready', builtAt: now }),
        },
        { status: 201 }
      )
    );
  } catch (err) {
    return noStore(caseFilesErrorResponse(err, 'build assemble'));
  }
}
