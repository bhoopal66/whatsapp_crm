// ============================================================
// GET /api/vault — Settings -> Vault (019c). Owner / admin only.
//
// Answers `{ configured, reason?, overview }`: whether the vault's keys
// are configured (`reason` is the fixed code when they are not:
// NOT_CONFIGURED, INVALID_KEYS, INVALID_CURRENT_KEY, INVALID_BLIND_KEY,
// UNAVAILABLE) and vault_overview for the caller, read on the service
// role without the keys, so the roles show on an unconfigured install
// too. `overview` is `{ bootstrapAvailable, myRole, roles: [{ userId,
// role, grantedBy, grantedAt, counts }] }`; roles is empty unless the
// caller's own vault role counts. Cache-Control: no-store.
// ============================================================

import { requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/groups/server';
import { vaultErrorResponse, vaultJson } from '@/lib/vault/http';
import { vaultStore } from '@/lib/vault/server';
import { vaultOverview } from '@/lib/vault/store';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const v = vaultStore();
    const overview = await vaultOverview(
      supabaseAdmin(),
      ctx.userId,
      ctx.accountId
    );
    return vaultJson(
      v.ok
        ? { configured: true, overview }
        : { configured: false, reason: v.reason, overview }
    );
  } catch (err) {
    return vaultErrorResponse(err);
  }
}
