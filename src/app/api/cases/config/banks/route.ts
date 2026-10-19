// ============================================================
// /api/cases/config/banks — Settings -> Cases: the account's banks
// (module 018c, migration 122). GET (agent and up): `{ banks }`, each
// `{ code, name, hasOwnStages }` (false: the bank uses the default stage
// list). POST (owner / admin) `{ code, name }` -> `{ bank }`, creating
// the bank or renaming it. The account is the caller's active one.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  configErrorResponse,
  readRows,
  requiredBankCode,
} from '@/lib/cases/config-http';
import { readObject, requiredText } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

/** 122's case_banks_name_check. */
const NAME_MAX = 100;

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const [banks, listed] = await Promise.all([
      readRows(
        ctx.supabase
          .from('case_banks')
          .select('code, name')
          .eq('account_id', ctx.accountId)
          .order('name')
          .order('code'),
        'case_banks'
      ),
      // A list holds positions 1..n, so one row per bank with its own list.
      readRows(
        ctx.supabase
          .from('case_bank_stages')
          .select('bank_code')
          .eq('account_id', ctx.accountId)
          .eq('position', 1),
        'case_bank_stages'
      ),
    ]);
    const own = new Set(listed.map((r) => String(r.bank_code)));
    return NextResponse.json({
      banks: banks.map((b) => ({
        code: String(b.code),
        name: String(b.name),
        hasOwnStages: own.has(String(b.code)),
      })),
    });
  } catch (err) {
    return configErrorResponse(err, 'config banks GET');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readObject(request);
    const code = requiredBankCode(body.code);
    const name = requiredText(body.name, 'name', NAME_MAX);
    const bank = await caseStore().upsertBank(
      ctx.userId,
      ctx.accountId,
      code,
      name
    );
    return NextResponse.json({ bank });
  } catch (err) {
    return configErrorResponse(err, 'config banks POST');
  }
}
