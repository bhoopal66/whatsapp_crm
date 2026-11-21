// ============================================================
// /api/desk/intake — staff uploads to the case desk (migration 220).
//
//   GET   any staff member -> 200 `{ items }`: their own uploads, newest
//         first, with each one's fate (filed to which case, waiting and
//         why, rejected and why, duplicate of whose).
//   POST  multipart/form-data: `idemKey` (8-80, reused on retry), an
//         optional `caption` (fills only the tags left empty), the tags
//         (`kind`, `bankCode`, `caseRef`, `companyName`, `tradeLicence`,
//         `product`, `contactId`, `docKey`, `note`) and an optional
//         `file` (PDF / JPEG / PNG, <= 10 MB) -> 201 `{ item }`, or 200
//         with `replayed: true` for a key already used.
//
// Refusals are `{ error, code }` (lib/desk/http.ts).
// TENANCY: the caller's active account; the SQL confines to it.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { declaredTooLarge } from '@/lib/case-files/http';
import {
  DeskBadRequest,
  deskErrorResponse,
  optionalText,
  parseIdemKey,
  parseTags,
} from '@/lib/desk/http';
import { mergeCaption } from '@/lib/desk/intake-form';
import { DeskRefusedError, DeskStore } from '@/lib/desk/store';
import {
  MAX_UPLOAD_BYTES,
  prepareIntakeFile,
  storeIntakeFile,
} from '@/lib/desk/upload';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const items = await new DeskStore(supabaseAdmin()).mine(
      ctx.userId,
      ctx.accountId
    );
    return NextResponse.json({ items });
  } catch (err) {
    return deskErrorResponse(err, 'intake list');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    if (declaredTooLarge(request)) throw new DeskRefusedError('FILE_INVALID');
    const form = await request.formData().catch(() => null);
    if (!form) throw new DeskBadRequest('Expected multipart/form-data');

    const idemKey = parseIdemKey(form.get('idemKey'));
    const caption = optionalText(form.get('caption'), 1000, 'caption');
    const merged = mergeCaption(
      parseTags((n) => form.get(n) ?? undefined),
      caption
    );

    const admin = supabaseAdmin();
    const store = new DeskStore(admin);
    const tags = { ...merged.tags };
    if (merged.deskCode !== null)
      tags.bankCode = await store.bankByShortCode(
        ctx.accountId,
        merged.deskCode
      );

    const itemId = crypto.randomUUID();
    const upload = form.get('file');
    let file = null;
    if (upload !== null) {
      if (!(upload instanceof File))
        throw new DeskBadRequest('file must be a file');
      if (upload.size > MAX_UPLOAD_BYTES)
        throw new DeskRefusedError('FILE_INVALID');
      const bytes = new Uint8Array(await upload.arrayBuffer());
      file = prepareIntakeFile(itemId, {
        bytes,
        mime: upload.type,
        originalName: upload.name,
      });
      await storeIntakeFile(admin.storage, file, bytes);
    }

    const item = await store.submit(ctx.userId, ctx.accountId, {
      itemId,
      idemKey,
      tags,
      file,
    });
    return NextResponse.json({ item }, { status: item.replayed ? 200 : 201 });
  } catch (err) {
    return deskErrorResponse(err, 'intake submit');
  }
}
