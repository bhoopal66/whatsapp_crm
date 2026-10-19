// ============================================================
// POST /api/vault/reveal — show one vaulted value (019c). Workspace
// owner / admin only; vault_reveal then checks the vault role, the
// reason (it refuses one carrying an identifier) and the rate limit, and
// audits every attempt. Needs the vault configured (503
// VAULT_NOT_CONFIGURED).
//
// Body `{ token, reason }`: token `vlt_` + 26 letters, reason non-blank,
// at most 500 characters. Answers `{ kind, value }`; refusals carry the
// store's status as code: 403 DENIED, 404 NOT_FOUND, 429 RATE_LIMITED,
// 409 DECRYPT_FAILED. Cache-Control: no-store, and neither the value,
// the token nor the reason is ever logged or echoed back.
// ============================================================

import { requireRole } from '@/lib/auth/account';
import {
  readTokenAndReason,
  requireVaultStore,
  vaultErrorResponse,
  vaultJson,
} from '@/lib/vault/http';

const REFUSALS = {
  DENIED: [403, 'Not allowed to reveal this value'],
  NOT_FOUND: [404, 'No such value'],
  RATE_LIMITED: [429, 'Too many reveals; try again later'],
  DECRYPT_FAILED: [409, 'The value could not be decrypted'],
} as const;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const { token, reason } = await readTokenAndReason(request);
    const store = requireVaultStore();
    const result = await store.reveal(ctx.userId, ctx.accountId, token, reason);
    if (!result.ok) {
      const [status, error] = REFUSALS[result.status];
      return vaultJson({ error, code: result.status }, status);
    }
    return vaultJson({ kind: result.kind, value: result.value });
  } catch (err) {
    return vaultErrorResponse(err);
  }
}
