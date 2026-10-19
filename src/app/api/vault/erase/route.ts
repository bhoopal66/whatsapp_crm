// ============================================================
// POST /api/vault/erase — delete one vaulted value (019c). Workspace
// owner / admin only; vault_delete then checks the vault role and audits.
// Needs the vault configured (503 VAULT_NOT_CONFIGURED).
//
// Body `{ token, reason }` (as reveal). Answers `{ status: 'OK' }`;
// refusals: 403 DENIED, 404 NOT_FOUND. Cache-Control: no-store.
// ============================================================

import { requireRole } from '@/lib/auth/account';
import {
  readTokenAndReason,
  requireVaultStore,
  vaultErrorResponse,
  vaultJson,
} from '@/lib/vault/http';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const { token, reason } = await readTokenAndReason(request);
    const store = requireVaultStore();
    const status = await store.delete(ctx.userId, ctx.accountId, token, reason);
    if (status === 'DENIED')
      return vaultJson(
        { error: 'Not allowed to erase this value', code: 'DENIED' },
        403
      );
    if (status === 'NOT_FOUND')
      return vaultJson({ error: 'No such value', code: 'NOT_FOUND' }, 404);
    return vaultJson({ status });
  } catch (err) {
    return vaultErrorResponse(err);
  }
}
