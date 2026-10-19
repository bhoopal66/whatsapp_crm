// ============================================================
// GET /api/vault/audit?limit= — the account's vault audit, newest first
// (019c). Workspace owner / admin only; vault_audit_list answers rows
// only to a vault role holder (anyone else gets none). Read without the
// keys (the audit never holds a value), so it works on an unconfigured
// install. limit 1–500, default 100. Answers `{ rows: [{ id, at, action,
// outcome, actor, accountId, token, kind, subjectType, subjectId,
// reason, detail }] }`. Cache-Control: no-store.
// ============================================================

import { requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/groups/server';
import {
  vaultBadRequest,
  vaultErrorResponse,
  vaultJson,
} from '@/lib/vault/http';
import { vaultAuditList } from '@/lib/vault/store';

const MAX = 500;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const raw = new URL(request.url).searchParams.get('limit');
    let limit: number | undefined;
    if (raw !== null && raw !== '') {
      limit = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
      if (!(limit >= 1 && limit <= MAX))
        throw vaultBadRequest(`limit must be a whole number 1–${MAX}`);
    }
    const rows = await vaultAuditList(
      supabaseAdmin(),
      ctx.userId,
      ctx.accountId,
      limit
    );
    return vaultJson({ rows });
  } catch (err) {
    return vaultErrorResponse(err);
  }
}
