// GET /api/desk/tray/[id]/preview — a short-lived link to one open tray
// document, for the preview on the Tray tab (U5, migration 248): 200
// `{ url, expiresAt, mime, name, kind }`. A 'case-files' copy is signed
// for 300 s; a public chat-media object is served as it is (expiresAt
// null). Only people who may sort the item (230's desk_tray_can_sort):
// otherwise 404 TRAY_NOT_FOUND. A document stored anywhere else is 404
// FILE_NOT_FOUND; 501 NOT_CONFIGURED when this install cannot sign. The
// audit row is written (by the SQL) before any URL; every answer is
// `Cache-Control: no-store`, and the URL is never logged.
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { signerOf } from '@/lib/case-files/download';
import { deskErrorResponse, requireUuid } from '@/lib/desk/http';
import { previewKind } from '@/lib/desk/preview';
import {
  DeskPreviewStore,
  noStore,
  notConfigured,
  trayPreviewUrl,
} from '@/lib/desk/preview-server';
import { DeskRefusedError } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const trayId = requireUuid((await params).id, 'id');
    const admin = supabaseAdmin();
    const signer = signerOf(admin?.storage);
    if (!signer) return notConfigured();
    const now = new Date();
    const file = await new DeskPreviewStore(admin).tray(
      ctx.userId,
      ctx.accountId,
      trayId,
      now
    );
    const link = await trayPreviewUrl(file, signer, now);
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
    return noStore(deskErrorResponse(err, 'tray preview'));
  }
}
