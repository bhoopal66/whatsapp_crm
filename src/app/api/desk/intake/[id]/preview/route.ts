// GET /api/desk/intake/[id]/preview — a short-lived link to one desk
// upload's file, for the preview beside the sort panel (U5, migration
// 248): 200 `{ url, expiresAt, mime, name, kind }`, the URL signed for
// 300 s. The uploader always; anyone else only while the upload waits in
// a queue they sort (220's intake_scope_ok). Refused or unknown: 404
// ITEM_NOT_FOUND; no file: 404 FILE_NOT_FOUND; 501 NOT_CONFIGURED when
// this install cannot sign. The audit row is written (by the SQL) before
// the URL is signed; every answer is `Cache-Control: no-store`, and the
// URL is never logged.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { signerOf } from '@/lib/case-files/download';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { previewKind } from '@/lib/desk/preview';
import {
  DeskPreviewStore,
  intakePreviewUrl,
  noStore,
  notConfigured,
} from '@/lib/desk/preview-server';
import { DeskRefusedError } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const itemId = requireUuid((await params).id, 'id');
    const admin = supabaseAdmin();
    const signer = signerOf(admin?.storage);
    if (!signer) return notConfigured();
    const now = new Date();
    const file = await new DeskPreviewStore(admin).intake(
      ctx.userId,
      ctx.accountId,
      itemId,
      now
    );
    const link = await intakePreviewUrl(itemId, file, signer, now);
    if (!link) throw new DeskRefusedError('FILE_NOT_FOUND');
    return noStore(
      NextResponse.json({
        url: link.url,
        expiresAt: link.expiresAt,
        mime: file.mime,
        name: file.originalName,
        kind: previewKind(file.mime, file.originalName),
      })
    );
  } catch (err) {
    return noStore(deskErrorResponse(err, 'intake preview'));
  }
}
