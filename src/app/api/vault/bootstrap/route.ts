// ============================================================
// POST /api/vault/bootstrap — make the caller the account's first vault
// super_admin (019c). Workspace owner only (an admin is 403); needs the
// vault configured (503 VAULT_NOT_CONFIGURED). vault_role_bootstrap
// refuses once any live vault role exists: 409 BOOTSTRAP_DENIED.
// Answers `{ status: 'OK' }`. Cache-Control: no-store.
// ============================================================

import { ForbiddenError, requireRole } from '@/lib/auth/account';
import { isOwner } from '@/lib/auth/roles';
import {
  requireVaultStore,
  VaultHttpError,
  vaultErrorResponse,
  vaultJson,
} from '@/lib/vault/http';

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    if (!isOwner(ctx.role))
      throw new ForbiddenError('Only the workspace owner can set up the vault');
    const store = requireVaultStore();
    const status = await store.bootstrap(ctx.userId, ctx.accountId, ctx.userId);
    if (status === 'DENIED')
      throw new VaultHttpError(409, {
        error: 'The vault already has a role holder',
        code: 'BOOTSTRAP_DENIED',
      });
    return vaultJson({ status });
  } catch (err) {
    return vaultErrorResponse(err);
  }
}
