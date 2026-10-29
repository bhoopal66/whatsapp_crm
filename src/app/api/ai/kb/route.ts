import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import { KB_ENTRY_COLUMNS, summarizeKb } from '@/lib/kb/requests';
import type { KbEntry } from '@/lib/kb/types';
import { redactClipped } from '@/lib/typesafe/checks/common';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * GET /api/ai/kb  (any member)
 *
 * The account's approved-answers library ordered by ref, counts per
 * audience × status, and — for admins only — the last five imports.
 */
export async function GET() {
  try {
    const { supabase, accountId, role } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('kb_entries')
      .select(KB_ENTRY_COLUMNS)
      .eq('account_id', accountId)
      .order('ref', { ascending: true });
    if (error) {
      console.error('[ai/kb GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load approved answers' },
        { status: 500 }
      );
    }
    const entries = (data ?? []) as KbEntry[];

    let imports: unknown[] = [];
    if (canEditSettings(role)) {
      const { data: rows, error: importsError } = await supabase
        .from('kb_imports')
        .select(
          'id, file_name, total, inserted, updated, unchanged, skipped, approved, created_at'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(5);
      // The history is a nicety: a failed read leaves it empty.
      if (importsError) {
        console.error('[ai/kb GET] imports error:', importsError);
      } else {
        imports = rows ?? [];
      }
    }

    return NextResponse.json({
      entries,
      summary: summarizeKb(entries),
      imports,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Longest question a new entry takes (gap topic labels are ≤ 500). */
const MAX_NEW_QUESTION = 2000;

/**
 * POST /api/ai/kb  (admin+) — `{ question }` starts a new approved
 * answer as a **draft** (never sent until someone approves it), so the
 * knowledge-gap card's "Write an approved answer" can open the existing
 * edit dialog on it. The ref is generated (`GAP-XXXXXX`): workbook
 * imports upsert by ref, and the prefix keeps a created row clear of
 * the sheet's own refs. The audience is `prospective_client`, a
 * customer audience, since the question came from a customer. The
 * question is redacted before it is stored.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const raw = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!raw || raw.length > MAX_NEW_QUESTION) {
      return NextResponse.json(
        { error: 'A question is required' },
        { status: 400 }
      );
    }
    // The question is a customer's own words: identifiers (Emirates ID,
    // card, IBAN, phone, email) are masked before it becomes library
    // text, the same redaction the TypeSafe gateway applies.
    const question = redactClipped(raw, MAX_NEW_QUESTION).trim();

    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
    const { data, error } = await supabase
      .from('kb_entries')
      .insert({
        account_id: accountId,
        ref: `GAP-${suffix.toUpperCase()}`,
        audience: 'prospective_client',
        question,
        status: 'draft',
        source: 'knowledge_gap',
      })
      .select(KB_ENTRY_COLUMNS)
      .single();
    if (error || !data) {
      console.error('[ai/kb POST] error:', error);
      return NextResponse.json(
        { error: 'Failed to start an answer' },
        { status: 500 }
      );
    }
    return NextResponse.json({ entry: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
