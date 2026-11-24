// POST /api/desk/tray/[id]/file — `{ caseId, confirmCompany? }` files a
// tray document to an open desk case of the caller's banks (migration
// 230). The sender's own document is registered at once; another
// person's (a PRO's) is copied through the desk intake in the caller's
// name and the tray item points at that upload. A case of a company the
// sender does not act for needs its legal name typed (CONFIRM_COMPANY).
// -> `{ outcome: 'filed', caseNumber, item? }`, or `{ outcome: 'waiting' }`
// when the copy is in the sorting queue (303).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  deskErrorResponse,
  optionalText,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { copyIntoIntake } from '@/lib/desk/route-inbound';
import { DeskRefusedError, DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const trayId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    const caseId = requireUuid(body.caseId, 'caseId');
    const confirm = optionalText(body.confirmCompany, 200, 'confirmCompany');
    const admin = supabaseAdmin();
    const store = new DeskStore(admin);
    const r = await store.trayFile(
      ctx.userId,
      ctx.accountId,
      trayId,
      caseId,
      confirm
    );
    if (r.outcome === 'filed')
      return NextResponse.json({ outcome: 'filed', caseNumber: r.caseNumber });
    if (r.outcome === 'waiting')
      return NextResponse.json({ outcome: 'waiting', caseNumber: null });
    if (!r.mediaUrl || !r.caseNumber)
      throw new DeskRefusedError('FILE_INVALID');
    // The tray item's id is the upload's: filing it twice replays.
    const item = await copyIntoIntake(admin, store, {
      actor: ctx.userId,
      accountId: ctx.accountId,
      itemId: trayId,
      idemKey: `tray:${trayId}`,
      tags: {
        kind: 'pending_doc',
        bankCode: null,
        caseRef: r.caseNumber,
        companyName: null,
        tradeLicence: null,
        product: null,
        contactId: null,
        docKey: null,
        note: null,
      },
      media: {
        mediaUrl: r.mediaUrl,
        mime: r.mime,
        originalName: r.originalName,
      },
    });
    if (item.state === 'untagged')
      return NextResponse.json({ outcome: 'waiting', caseNumber: null, item });
    await store.trayResolve(
      ctx.userId,
      ctx.accountId,
      trayId,
      caseId,
      item.itemId
    );
    return NextResponse.json({
      outcome: 'filed',
      caseNumber: r.caseNumber,
      item,
    });
  } catch (err) {
    return deskErrorResponse(err, 'tray file');
  }
}
