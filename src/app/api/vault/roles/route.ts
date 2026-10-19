// ============================================================
// /api/vault/roles — grant (POST) or revoke (DELETE) a vault role
// (019c). Workspace owner / admin only; the vault_role_* functions then
// decide (a vault super_admin grants and revokes). Needs the vault
// configured (503 VAULT_NOT_CONFIGURED).
//
// Body `{ user_id, role: 'admin' | 'super_admin' }` (user_id is the auth
// user id). Answers `{ status: 'OK' | 'NOOP' }`; a refusal is 409
// ROLE_DENIED. Cache-Control: no-store.
// ============================================================

import { requireRole } from '@/lib/auth/account';
import {
  readJsonObject,
  requireVaultStore,
  vaultBadRequest,
  VaultHttpError,
  vaultErrorResponse,
  vaultJson,
} from '@/lib/vault/http';
import type { VaultRole } from '@/lib/vault/store';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly VaultRole[] = ['admin', 'super_admin'];

async function change(request: Request, op: 'grant' | 'revoke') {
  try {
    const ctx = await requireRole('admin');
    const body = await readJsonObject(request);
    const userId = body?.user_id;
    const role = body?.role;
    if (typeof userId !== 'string' || !UUID_RE.test(userId))
      throw vaultBadRequest('user_id is not valid');
    if (!ROLES.includes(role as VaultRole))
      throw vaultBadRequest('role must be admin or super_admin');
    const store = requireVaultStore();
    const status = await store[op](
      ctx.userId,
      ctx.accountId,
      userId,
      role as VaultRole
    );
    if (status === 'DENIED')
      throw new VaultHttpError(409, {
        error: 'Not allowed to change this vault role',
        code: 'ROLE_DENIED',
      });
    return vaultJson({ status });
  } catch (err) {
    return vaultErrorResponse(err);
  }
}

export function POST(request: Request) {
  return change(request, 'grant');
}

export function DELETE(request: Request) {
  return change(request, 'revoke');
}
