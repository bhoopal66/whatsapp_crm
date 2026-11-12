// ============================================================
// GET /api/brain/pages/[kind]/[key] — one AI-generated summary page (022c,
// package 022c). Any caller with sales access, viewers included: the SQL
// read rule (brain_page_read, as the caller) decides, and returns nothing
// unless every item the page was built from is visible to them.
// -> 200 `{ kind, key, summary, aiGenerated: true, version, builtAt,
// citations: [{ kind, id }] }`, `Cache-Control: no-store`. `citations`
// are only the items the summary actually cites.
// An unknown kind, a case/contact key that is not a uuid, a missing page
// and a page the caller may not read are the IDENTICAL 404 body: no
// existence or id-format oracle.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { isUuid } from '@/lib/cases/http';
import { BRAIN_PAGE_KINDS, type BrainPageKind } from '@/lib/brain/pages';
import {
  BrainHttpError,
  brainErrorResponse,
  brainPages,
  requireBrain,
} from '@/lib/brain/server';

type Params = { params: Promise<{ kind: string; key: string }> };

const BANK_KEY_MAX = 64;
const notFound = () => new BrainHttpError(404, 'Not found');

function validKey(kind: BrainPageKind, key: string): boolean {
  if (kind === 'bank') return key.length > 0 && key.length <= BANK_KEY_MAX;
  return isUuid(key);
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    const { kind, key } = await params;
    if (!(BRAIN_PAGE_KINDS as readonly string[]).includes(kind))
      throw notFound();
    const k = kind as BrainPageKind;
    if (!validKey(k, key)) throw notFound();
    const page = await brainPages().read(ctx.userId, ctx.accountId, k, key);
    if (!page) throw notFound();
    return NextResponse.json(
      {
        kind: k,
        key,
        summary: page.summary,
        aiGenerated: true,
        version: page.version,
        builtAt: page.builtAt ? page.builtAt.toISOString() : null,
        citations: page.citations.map((c) => ({ kind: c.kind, id: c.id })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return brainErrorResponse(err, 'pages');
  }
}
