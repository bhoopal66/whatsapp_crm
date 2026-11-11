// ============================================================
// /api/cases/config/banks/[code]/file-specs — one bank + product's case
// document file spec (migration 181). GET (agent and up, as the
// documents config route) `?product=` -> `{ product, requirements:
// [{ docKey, label }], rows: [{ docKey, position, namePattern, required,
// maxMb, allowedMime, minValidDays, merged }], usesDefaults }`; rows are
// read through the caller's RLS client, in position order, and
// `usesDefaults` is true when none is stored (the cases then take every
// requirement as required, with the default name, size and types).
// PUT (owner / admin) `{ product, rows: [{ docKey, position,
// namePattern?, required, maxMb, allowedMime, minValidDays?, merged }] }`
// replaces the spec through case_file_spec_set (service role, which
// re-checks the writer) -> `{ auditId }`; `rows: []` removes it. The rows
// are checked in full before the call (422 SPEC_INVALID). Products match
// case-insensitively after trimming spaces, as 181 does.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { caseFilesErrorResponse, parseSpecRows } from '@/lib/case-files/http';
import { CaseFilesStore } from '@/lib/case-files/store';
import {
  bankCodeParam,
  queryParam,
  readRows,
  requireBank,
} from '@/lib/cases/config-http';
import { readObject, requiredText } from '@/lib/cases/http';
import { caseToolsStore } from '@/lib/cases/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ code: string }> };

const TEXT_MAX = 200;

/** 181's `lower(btrim(product))`: btrim strips spaces only. */
const productKey = (p: string) => p.replace(/^ +| +$/g, '').toLowerCase();

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('agent'));
    const code = bankCodeParam((await params).code);
    const product = requiredText(
      queryParam(request, 'product'),
      'product',
      TEXT_MAX
    );
    await requireBank(ctx.supabase, ctx.accountId, code);
    const key = productKey(product);
    const [{ requirements }, specRows] = await Promise.all([
      caseToolsStore().bankConfig(ctx.accountId, code),
      readRows(
        ctx.supabase
          .from('case_file_specs')
          .select(
            'product, doc_key, position, name_pattern, required, max_mb, allowed_mime, min_valid_days, merged'
          )
          .eq('account_id', ctx.accountId)
          .eq('bank_code', code)
          .order('position')
          .order('doc_key'),
        'case_file_specs'
      ),
    ]);
    const rows = specRows
      .filter((r) => productKey(String(r.product)) === key)
      .map((r) => ({
        docKey: String(r.doc_key),
        position: Number(r.position),
        namePattern: String(r.name_pattern),
        required: r.required === true,
        maxMb: Number(r.max_mb),
        allowedMime: Array.isArray(r.allowed_mime)
          ? r.allowed_mime.map(String)
          : [],
        minValidDays:
          r.min_valid_days === null || r.min_valid_days === undefined
            ? null
            : Number(r.min_valid_days),
        merged: r.merged === true,
      }));
    return NextResponse.json({
      product,
      requirements: requirements
        .filter((r) => productKey(r.product) === key)
        .map((r) => ({ docKey: r.docKey, label: r.label })),
      rows,
      usesDefaults: rows.length === 0,
    });
  } catch (err) {
    return caseFilesErrorResponse(err, 'config file specs GET');
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const code = bankCodeParam((await params).code);
    const body = await readObject(request);
    const product = requiredText(body.product, 'product', TEXT_MAX);
    const rows = parseSpecRows(body.rows);
    const auditId = await new CaseFilesStore(supabaseAdmin()).setSpec(
      ctx.userId,
      code,
      product,
      rows
    );
    return NextResponse.json({ auditId });
  } catch (err) {
    return caseFilesErrorResponse(err, 'config file specs PUT');
  }
}
