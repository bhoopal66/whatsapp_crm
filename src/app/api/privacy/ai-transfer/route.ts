// /api/privacy/ai-transfer — the workspace's legal basis for sending
// customer text to AI providers abroad (migration 224). Owners and admins.
//   GET -> `{ basis: {…} | null, last_30_days, refused_30_days }`
//   PUT `{ basis, note, approvedBy, region, requireBasis }`
// With requireBasis on, every AI call is refused until all four basis
// fields are filled (basis consent | contract | adequacy | scc | other,
// note 20-2000 characters).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  noStore,
  PrivacyBadRequest,
  privacyErrorResponse,
  readBody,
} from '@/lib/privacy/http';
import { PrivacyStore } from '@/lib/privacy/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

const BASES = ['consent', 'contract', 'adequacy', 'scc', 'other'];

function optText(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string')
    throw new PrivacyBadRequest(`${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new PrivacyBadRequest(`${name} is too long`);
  return t === '' ? null : t;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    return noStore(
      NextResponse.json(
        await new PrivacyStore(supabaseAdmin()).aiTransfer(
          ctx.userId,
          ctx.accountId
        )
      )
    );
  } catch (err) {
    return privacyErrorResponse(err, 'ai transfer get');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readBody(request);
    const basis = optText(body.basis, 'basis', 20);
    if (basis !== null && !BASES.includes(basis))
      throw new PrivacyBadRequest(`basis must be one of ${BASES.join(', ')}`);
    if (typeof body.requireBasis !== 'boolean')
      throw new PrivacyBadRequest('requireBasis must be true or false');
    const note = optText(body.note, 'note', 2000);
    if (note !== null && note.length < 20)
      throw new PrivacyBadRequest('note must be at least 20 characters');
    const out = await new PrivacyStore(supabaseAdmin()).aiTransfer(
      ctx.userId,
      ctx.accountId,
      {
        basis,
        note,
        approvedBy: optText(body.approvedBy, 'approvedBy', 200),
        region: optText(body.region, 'region', 100),
        requireBasis: body.requireBasis,
      }
    );
    return noStore(NextResponse.json(out));
  } catch (err) {
    return privacyErrorResponse(err, 'ai transfer set');
  }
}
