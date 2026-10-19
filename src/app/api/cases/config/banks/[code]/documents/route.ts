// ============================================================
// /api/cases/config/banks/[code]/documents — one bank's required
// documents, per product (module 018c, migration 123). GET (agent and
// up): `{ requirements }` for every product, each `{ accountId, bankCode,
// product, docKey, label, position }`. POST (owner / admin) `{ product,
// doc_key, label, position? }` -> `{ requirement }` (create or update;
// products match case- and space-insensitively). DELETE
// `?product=&key=` -> `{ deleted }`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  bankCodeParam,
  configErrorResponse,
  optionalPositiveInt,
  queryParam,
  requireBank,
} from '@/lib/cases/config-http';
import { readObject, requiredKey, requiredText } from '@/lib/cases/http';
import { caseToolsStore } from '@/lib/cases/server';

type Params = { params: Promise<{ code: string }> };

const TEXT_MAX = 200;

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const code = bankCodeParam((await params).code);
    await requireBank(ctx.supabase, ctx.accountId, code);
    const { requirements } = await caseToolsStore().bankConfig(
      ctx.accountId,
      code
    );
    return NextResponse.json({ requirements });
  } catch (err) {
    return configErrorResponse(err, 'config documents GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const body = await readObject(request);
    const requirement = await caseToolsStore().upsertDocRequirement(
      ctx.userId,
      {
        accountId: ctx.accountId,
        bankCode: code,
        product: requiredText(body.product, 'product', TEXT_MAX),
        docKey: requiredKey(body.doc_key, 'doc_key'),
        label: requiredText(body.label, 'label', TEXT_MAX),
        position: optionalPositiveInt(body.position, 'position'),
      }
    );
    return NextResponse.json({ requirement });
  } catch (err) {
    return configErrorResponse(err, 'config documents POST');
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const product = requiredText(
      queryParam(request, 'product'),
      'product',
      TEXT_MAX
    );
    const key = requiredKey(queryParam(request, 'key'), 'key');
    const deleted = await caseToolsStore().deleteDocRequirement(
      ctx.userId,
      ctx.accountId,
      code,
      product,
      key
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return configErrorResponse(err, 'config documents DELETE');
  }
}
