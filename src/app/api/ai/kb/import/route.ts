import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { readXlsxSheets } from '@/lib/contacts/read-xlsx';
import { parseKbTable, pickKbSheet } from '@/lib/kb/import';
import { isKbWorkbookName, MAX_KB_UPLOAD_BYTES } from '@/lib/kb/requests';

/**
 * POST /api/ai/kb/import  (admin+)
 *
 * multipart/form-data with one `.xlsx` `file`, the approved-answers
 * review workbook. Its Knowledge_Base sheet is parsed and upserted by
 * ref through `kb_import`, as the caller (RLS applies), in one
 * transaction that also writes the audit row.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (file.size > MAX_KB_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `File is too large (max ${Math.round(MAX_KB_UPLOAD_BYTES / 1024 / 1024)} MB).`,
        },
        { status: 413 }
      );
    }
    if (!isKbWorkbookName(file.name)) {
      return NextResponse.json(
        { error: 'Upload the review workbook as an .xlsx file.' },
        { status: 415 }
      );
    }

    let sheets: { name: string; rows: string[][] }[];
    try {
      sheets = await readXlsxSheets(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      console.error('[ai/kb/import] read error:', err);
      return NextResponse.json(
        { error: 'The file could not be read as an .xlsx workbook.' },
        { status: 400 }
      );
    }
    const sheet = pickKbSheet(sheets);
    if (!sheet) {
      return NextResponse.json(
        { error: 'No Knowledge_Base sheet found' },
        { status: 400 }
      );
    }

    const { rows, issues } = parseKbTable(sheet.rows);
    const { data, error } = await supabase.rpc('kb_import', {
      p_account_id: accountId,
      p_file_name: file.name,
      p_rows: rows,
      p_issues: issues,
    });
    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'Only an admin can import answers' },
          { status: 403 }
        );
      }
      console.error('[ai/kb/import] rpc error:', error);
      return NextResponse.json(
        { error: 'Failed to import answers' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ...(data as object),
      sheet: sheet.name,
      issues,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
