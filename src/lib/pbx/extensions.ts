import type { SupabaseClient } from '@supabase/supabase-js';
import { parseMyWorkspaces, type Workspace } from '@/lib/auth/my-workspaces';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import type { ExtensionOnline } from './yeastar/api';
import type { RegistrationClient } from './yeastar/events';

/**
 * Who may hold an extension: an active owner, admin, team leader or
 * agent of the extension's workspace. Mirrors pbx_extensions_guard
 * (migration 089), which names the roles positively, so it is a list,
 * not a rank — STAFF_ROLES includes viewer. Change one, change both.
 */
export const EXTENSION_ROLES = [
  'owner',
  'admin',
  'team_leader',
  'agent',
] as const satisfies readonly AccountRole[];

export function canHoldExtension(role: unknown): boolean {
  return (EXTENSION_ROLES as readonly unknown[]).includes(role);
}

/** Digits only (Arabic-Indic digits read as 0-9), for DIDs and bank numbers. */
export function digitsOnly(raw: unknown): string {
  return typeof raw === 'string'
    ? raw
        .replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf))
        .replace(/\D/g, '')
    : '';
}

/**
 * The registration columns from `extension/list`'s online flags, in the
 * vocabulary of the 30007 registration event. With several clients
 * online the first of desk phone, desktop, web, mobile is named.
 */
export function registrationOf(online: ExtensionOnline): {
  registration_state: 'registered' | 'unregistered';
  client_kind: RegistrationClient | null;
} {
  const kind: RegistrationClient | null = online.sipPhone
    ? 'sip'
    : online.linkusDesktop
      ? 'desktop'
      : online.linkusWeb
        ? 'web'
        : online.linkusMobile
          ? 'mobile'
          : null;
  return {
    registration_state: kind ? 'registered' : 'unregistered',
    client_kind: kind,
  };
}

/**
 * The workspaces where the caller is an active owner or admin — the
 * only ones a route or an extension may be pointed at. Read with the
 * caller's own client: my_workspaces() answers for auth.uid().
 */
export async function adminWorkspaces(
  supabase: SupabaseClient
): Promise<Workspace[]> {
  const { data, error } = await supabase.rpc('my_workspaces');
  if (error) throw new Error(`my_workspaces failed: ${error.message}`);
  return parseMyWorkspaces(data).filter(
    (w) => !w.deactivated && w.role !== null && hasMinRole(w.role, 'admin')
  );
}

export interface ExtensionView {
  id: string;
  extension: string;
  accountId: string;
  /** Null when unmapped, or mapped in a workspace the caller does not administer. */
  userId: string | null;
  personName: string | null;
  mapped: boolean;
  softphoneEnabled: boolean;
  presenceMonitor: boolean;
  registrationState: string | null;
  clientKind: string | null;
  updatedAt: string;
}

export const EXTENSION_COLUMNS =
  'id, extension, account_id, user_id, softphone_enabled, presence_monitor, registration_state, client_kind, updated_at';

type ExtensionRow = Record<string, unknown> & { account_id: string };

const nameOf = (p: Record<string, unknown>) =>
  (typeof p.full_name === 'string' && p.full_name.trim()) ||
  (typeof p.email === 'string' && p.email) ||
  null;

/**
 * Extension rows as the admin screen shows them. A person is named only
 * in a workspace the caller administers (`adminIds`); elsewhere the row
 * says only that it is mapped. `db` is the service-role client.
 */
export async function extensionViews(
  db: SupabaseClient,
  rows: ExtensionRow[],
  adminIds: ReadonlySet<string>
): Promise<ExtensionView[]> {
  const visible = (r: ExtensionRow) =>
    adminIds.has(r.account_id) && typeof r.user_id === 'string';
  const userIds = [...new Set(rows.filter(visible).map((r) => r.user_id))];
  const names = new Map<string, string | null>();
  if (userIds.length) {
    const { data, error } = await db
      .from('profiles')
      .select('user_id, account_id, full_name, email')
      .in('user_id', userIds);
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    for (const p of (data ?? []) as Record<string, unknown>[])
      names.set(`${p.account_id}:${p.user_id}`, nameOf(p));
  }
  return rows.map((r) => ({
    id: String(r.id),
    extension: String(r.extension),
    accountId: r.account_id,
    userId: visible(r) ? String(r.user_id) : null,
    personName: visible(r)
      ? (names.get(`${r.account_id}:${r.user_id}`) ?? null)
      : null,
    mapped: typeof r.user_id === 'string',
    softphoneEnabled: r.softphone_enabled === true,
    presenceMonitor: r.presence_monitor !== false,
    registrationState: (r.registration_state as string | null) ?? null,
    clientKind: (r.client_kind as string | null) ?? null,
    updatedAt: String(r.updated_at ?? ''),
  }));
}

/** A connection's extensions, ordered by number. */
export async function connectionExtensions(
  db: SupabaseClient,
  connectionId: string,
  adminIds: ReadonlySet<string>
): Promise<ExtensionView[]> {
  const { data, error } = await db
    .from('pbx_extensions')
    .select(EXTENSION_COLUMNS)
    .eq('connection_id', connectionId)
    .order('extension', { ascending: true });
  if (error) throw new Error(`pbx_extensions read failed: ${error.message}`);
  return extensionViews(db, (data ?? []) as ExtensionRow[], adminIds);
}

/** The people an extension may be mapped to, per administered workspace. */
export async function mappableWorkspaces(
  db: SupabaseClient,
  workspaces: Workspace[]
): Promise<
  {
    accountId: string;
    name: string;
    people: { userId: string; name: string | null }[];
  }[]
> {
  if (!workspaces.length) return [];
  const { data, error } = await db
    .from('profiles')
    .select('user_id, account_id, account_role, full_name, email')
    .in(
      'account_id',
      workspaces.map((w) => w.accountId)
    )
    .is('deactivated_at', null);
  if (error) throw new Error(`profiles read failed: ${error.message}`);
  const rows = ((data ?? []) as Record<string, unknown>[]).filter((p) =>
    canHoldExtension(p.account_role)
  );
  return workspaces.map((w) => ({
    accountId: w.accountId,
    name: w.name,
    people: rows
      .filter((p) => p.account_id === w.accountId)
      .map((p) => ({ userId: String(p.user_id), name: nameOf(p) })),
  }));
}
