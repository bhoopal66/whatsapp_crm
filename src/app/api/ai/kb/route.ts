import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import { KB_ENTRY_COLUMNS, summarizeKb } from '@/lib/kb/requests';
import type { KbEntry } from '@/lib/kb/types';

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
