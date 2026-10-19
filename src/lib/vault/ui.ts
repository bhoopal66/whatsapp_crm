// ============================================================
// Settings -> Vault's pure helpers (module 019c): the defensive
// parsers for GET /api/vault and GET /api/vault/audit, the token shape,
// the reason hint and the error-code -> `Vault.errors.*` key map.
//
// Nothing here ever sees a revealed value: reveal answers are read by
// the shared reveal pieces in components/memory/reveal-dialog.tsx and
// held only in the open dialog's state.
// ============================================================

export type VaultRoleName = 'admin' | 'super_admin';

export const VAULT_ROLE_NAMES: readonly VaultRoleName[] = [
  'super_admin',
  'admin',
];

/** GET /api/vault's `reason` codes when the keys are not usable. */
export const NOT_CONFIGURED_REASONS = [
  'NOT_CONFIGURED',
  'INVALID_KEYS',
  'INVALID_CURRENT_KEY',
  'INVALID_BLIND_KEY',
  'UNAVAILABLE',
] as const;

export interface VaultRoleView {
  userId: string;
  role: VaultRoleName;
  grantedBy: string | null;
  grantedAt: string | null;
  /** The holder is still a live owner / admin here; else the role is dormant. */
  counts: boolean;
}

export interface VaultOverviewView {
  configured: boolean;
  /** One of NOT_CONFIGURED_REASONS (anything else reads UNAVAILABLE), null when configured. */
  reason: string | null;
  bootstrapAvailable: boolean;
  myRole: VaultRoleName | null;
  roles: VaultRoleView[];
}

export interface VaultAuditView {
  id: string;
  at: string | null;
  action: string;
  outcome: string;
  actor: string | null;
  token: string | null;
  kind: string | null;
  reason: string | null;
  /** detail.why on a refusal (NO_ROLE, LAST_SUPER_ADMIN, …). */
  why: string | null;
  /** The person a role row was about (detail.user_id). */
  targetUserId: string | null;
  /** The role a role row was about (detail.role). */
  targetRole: VaultRoleName | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && !Number.isNaN(new Date(s).getTime()) ? s : null;
};
const asRole = (v: unknown): VaultRoleName | null =>
  VAULT_ROLE_NAMES.includes(v as VaultRoleName) ? (v as VaultRoleName) : null;
const time = (s: string | null) => (s === null ? 0 : new Date(s).getTime());

/**
 * GET /api/vault, or null when the answer is not that shape. Fails
 * closed: setup is offered only for a literal true, an unknown role is
 * no role, and a role row without a user id or a known role is dropped.
 * Rows come super admins first, then oldest grant first.
 */
export function parseVaultOverview(json: unknown): VaultOverviewView | null {
  const o = obj(json);
  const ov = obj(o?.overview);
  if (!o || !ov || typeof o.configured !== 'boolean') return null;
  const roles: VaultRoleView[] = [];
  for (const raw of Array.isArray(ov.roles) ? ov.roles : []) {
    const r = obj(raw);
    const userId = str(r?.userId);
    const role = asRole(r?.role);
    if (!r || userId === null || role === null) continue;
    roles.push({
      userId,
      role,
      grantedBy: str(r.grantedBy),
      grantedAt: iso(r.grantedAt),
      counts: r.counts === true,
    });
  }
  roles.sort(
    (a, b) =>
      VAULT_ROLE_NAMES.indexOf(a.role) - VAULT_ROLE_NAMES.indexOf(b.role) ||
      time(a.grantedAt) - time(b.grantedAt)
  );
  const reason = str(o.reason);
  return {
    configured: o.configured,
    reason: o.configured
      ? null
      : (NOT_CONFIGURED_REASONS as readonly string[]).includes(reason ?? '')
        ? reason
        : 'UNAVAILABLE',
    bootstrapAvailable: ov.bootstrapAvailable === true,
    myRole: asRole(ov.myRole),
    roles,
  };
}

/** GET /api/vault/audit's rows, newest first; null when `rows` is missing. */
export function parseAudit(json: unknown): VaultAuditView[] | null {
  const rows = obj(json)?.rows;
  if (!Array.isArray(rows)) return null;
  const out: VaultAuditView[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    const id = str(r?.id);
    const action = str(r?.action);
    const outcome = str(r?.outcome);
    if (!r || id === null || action === null || outcome === null) continue;
    const detail = obj(r.detail);
    out.push({
      id,
      at: iso(r.at),
      action,
      outcome,
      actor: str(r.actor),
      token: str(r.token),
      kind: str(r.kind),
      reason: str(r.reason),
      why: str(detail?.why),
      targetUserId: str(detail?.user_id),
      targetRole: asRole(detail?.role),
    });
  }
  return out.sort((a, b) => time(b.at) - time(a.at));
}

/** migration 121's token CHECK (and lib/vault/http's VAULT_TOKEN_RE). */
export function isVaultToken(token: string): boolean {
  return /^vlt_[ghjkmnpqrstvwxyz]{26}$/.test(token);
}

/** POST /api/vault/reveal and /erase's reason bound (code points). */
export const VAULT_REASON_MAX = 500;

/**
 * A client hint mirroring vault_reason_problem (migration 121): would
 * the server refuse this reason for carrying an identifier? After NFKC
 * (with Arabic-Indic and Persian digits folded to ASCII): 12+ digits in
 * total; a run of 7+ digits once everything that is not a letter or
 * digit is removed; a passport-like token (a letter, up to 3 separators,
 * 6-8 digits); an AE IBAN prefix ('AE' and 2 digits). Any other
 * script's decimal digit is refused outright.
 * The server stays the judge; this only warns before sending.
 */
export function reasonLooksLikeIdentifier(reason: string): boolean {
  const n = reason
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (/(?![0-9])\p{Nd}/u.test(n)) return true;
  if (n.replace(/[^0-9]/g, '').length >= 12) return true;
  if (/[0-9]{7}/.test(n.replace(/[^\p{L}\p{N}]/gu, ''))) return true;
  // A passport-like token ('Z - 654321') and an AE IBAN prefix ('AE 07').
  if (/(^|[^\p{L}\p{N}])\p{L}[^\p{L}\p{N}]{0,3}[0-9]{6,8}([^0-9]|$)/u.test(n))
    return true;
  return /AE\s?[0-9]{2}/i.test(n);
}

/**
 * The `Vault.errors.*` key for a failed vault call: the code first (the
 * routes' `{ code }`), then the status.
 */
export function vaultErrorKey(status: number, code: unknown): string {
  switch (code) {
    case 'VAULT_NOT_CONFIGURED':
      return 'notConfigured';
    case 'ROLE_DENIED':
      return 'roleDenied';
    case 'BOOTSTRAP_DENIED':
      return 'bootstrapDenied';
    case 'DENIED':
      return 'denied';
    case 'NOT_FOUND':
      return 'notFound';
    case 'RATE_LIMITED':
      return 'rateLimited';
    case 'DECRYPT_FAILED':
      return 'decryptFailed';
  }
  if (status === 503) return 'notConfigured';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  // The token's shape and the reason's length are checked before
  // sending, so a 400 is the reason refused for carrying an identifier.
  if (status === 400) return 'reasonRefused';
  return 'failed';
}
