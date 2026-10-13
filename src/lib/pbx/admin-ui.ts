// ============================================================
// Settings → Phone system: the pure decisions behind the admin screen
// (src/components/settings/phone-system). No I/O and no DOM, so the
// rules are tested in the node environment; the components only render
// what these return.
//
// The validators mirror the /api/pbx routes' own parsing so a mistake
// is named next to its field instead of coming back as one English 400.
// The routes stay the authority.
// ============================================================

import { digitsOnly } from './extensions';

/** Mirrors PBX_AUTH_BACKOFF_MS in ./connection (server-only: it decrypts). */
export const PBX_AUTH_BACKOFF_MINUTES = 5;

// ---------- API shapes (camelCase, as the routes answer) ----------

export type PbxEdition = 'cloud' | 'software' | 'appliance';
export const PBX_EDITIONS: readonly PbxEdition[] = [
  'cloud',
  'software',
  'appliance',
];

/** GET/PUT /api/pbx/connection → `connection`. */
export interface PbxConnectionView {
  id: string;
  label: string;
  edition: PbxEdition;
  baseUrl: string;
  apiPath: string;
  clientIdLast4: string | null;
  firmware: string | null;
  status: string;
  lastEventAt: string | null;
  lastError: string | null;
  updatedAt: string;
  webhookUrl: string;
  hasClientSecret: boolean;
  hasSdkCredentials: boolean;
  hasWebhookSecret: boolean;
  mappedExtensions: number;
  softphoneUsers: number;
}

/** One row of GET /api/pbx/extensions (sync adds the two optionals). */
export interface PbxExtensionView {
  id: string;
  extension: string;
  accountId: string;
  userId: string | null;
  personName: string | null;
  mapped: boolean;
  softphoneEnabled: boolean;
  presenceMonitor: boolean;
  registrationState: string | null;
  clientKind: string | null;
  updatedAt: string;
  onPbx?: boolean;
  callerIdName?: string | null;
}

/** A workspace the caller administers, with who may hold an extension. */
export interface MappableWorkspace {
  accountId: string;
  name: string;
  people: { userId: string; name: string | null }[];
}

// ---------- Connection status ----------

export type ConnectionState =
  'none' | 'connected' | 'auth_failed' | 'not_connected';
export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'brown' | 'muted';

/** What the Connection card says, and in which colour. */
export function connectionState(conn: { status: string } | null): {
  state: ConnectionState;
  tone: Tone;
} {
  if (!conn) return { state: 'none', tone: 'amber' };
  if (conn.status === 'connected') return { state: 'connected', tone: 'green' };
  if (conn.status === 'auth_failed')
    return { state: 'auth_failed', tone: 'red' };
  return { state: 'not_connected', tone: 'amber' };
}

export type AgoUnit = 's' | 'min' | 'h' | 'd';

/**
 * "last event 2 s ago" as message inputs: the largest whole unit, a
 * future stamp (clock skew) reading as 0 s. Null when nothing has
 * arrived yet or the stamp does not parse.
 */
export function lastEventAgo(
  lastEventAt: string | null,
  now: Date
): { unit: AgoUnit; count: number } | null {
  if (!lastEventAt) return null;
  const at = Date.parse(lastEventAt);
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (s < 60) return { unit: 's', count: s };
  if (s < 3600) return { unit: 'min', count: Math.floor(s / 60) };
  if (s < 86_400) return { unit: 'h', count: Math.floor(s / 3600) };
  return { unit: 'd', count: Math.floor(s / 86_400) };
}

/** The host of the PBX address for the card ("pbx.example.com"). */
export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * The workspaces the header says the PBX is shared by: those with at
 * least one routed number, by name, each once. A route to a workspace
 * whose name the caller cannot see is left out.
 */
export function routedWorkspaceNames(
  routes: readonly { accountId: string | null }[],
  workspaces: readonly { accountId: string; name: string }[]
): string[] {
  const names = new Map(workspaces.map((w) => [w.accountId, w.name]));
  const out = new Set<string>();
  for (const r of routes) {
    const name = r.accountId ? names.get(r.accountId)?.trim() : undefined;
    if (name) out.add(name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// ---------- Extensions ----------

export type ExtensionState =
  'registered' | 'desk_phone' | 'unmapped' | 'offline';

const STATE_TONE: Record<ExtensionState, Tone> = {
  registered: 'green',
  desk_phone: 'grey',
  unmapped: 'brown',
  offline: 'muted',
};

/**
 * The State column. Unmapped wins (it is the admin's to fix); a mapped
 * extension registered from a SIP desk phone is "Desk phone", from any
 * Linkus client "Registered", and anything else is offline.
 */
export function extensionState(
  ext: Pick<PbxExtensionView, 'mapped' | 'registrationState' | 'clientKind'>
): { state: ExtensionState; tone: Tone } {
  const state: ExtensionState = !ext.mapped
    ? 'unmapped'
    : ext.registrationState !== 'registered'
      ? 'offline'
      : ext.clientKind === 'sip'
        ? 'desk_phone'
        : 'registered';
  return { state, tone: STATE_TONE[state] };
}

/** May the caller change this row? Only in a workspace they administer. */
export function canEditExtension(
  ext: Pick<PbxExtensionView, 'accountId'>,
  workspaces: readonly Pick<MappableWorkspace, 'accountId'>[]
): boolean {
  return workspaces.some((w) => w.accountId === ext.accountId);
}

export interface ExtensionPatch {
  userId?: string | null;
  accountId?: string;
  softphoneEnabled?: boolean;
  presenceMonitor?: boolean;
}

/**
 * The PATCH for moving an extension to another workspace: the person
 * stays only if they may hold an extension there too, because the
 * route refuses a person who is not staff of the target workspace.
 */
export function workspaceChangePatch(
  ext: Pick<PbxExtensionView, 'userId'>,
  targetAccountId: string,
  workspaces: readonly MappableWorkspace[]
): { accountId: string; userId: string | null } {
  const target = workspaces.find((w) => w.accountId === targetAccountId);
  const stays =
    !!ext.userId && !!target?.people.some((p) => p.userId === ext.userId);
  return { accountId: targetAccountId, userId: stays ? ext.userId : null };
}

/** The row as it will look once `patch` saves (the optimistic update). */
export function applyExtensionPatch(
  ext: PbxExtensionView,
  patch: ExtensionPatch,
  workspaces: readonly MappableWorkspace[]
): PbxExtensionView {
  const next: PbxExtensionView = { ...ext };
  if (patch.accountId !== undefined) next.accountId = patch.accountId;
  if (patch.userId !== undefined) {
    next.userId = patch.userId;
    next.mapped = patch.userId !== null;
    next.personName =
      patch.userId === null
        ? null
        : (workspaces
            .find((w) => w.accountId === next.accountId)
            ?.people.find((p) => p.userId === patch.userId)?.name ?? null);
  }
  if (patch.softphoneEnabled !== undefined)
    next.softphoneEnabled = patch.softphoneEnabled;
  if (patch.presenceMonitor !== undefined)
    next.presenceMonitor = patch.presenceMonitor;
  return next;
}

// ---------- Number lists (routes and bank numbers) ----------

/** Digits plus the separators people type into a phone number. */
const NUMBER_CHARS = /^[0-9٠-٩۰-۹+\-().\s]*$/;

export type NumberIssue =
  'number_required' | 'number_invalid' | 'number_duplicate';

function numberIssue(
  raw: string,
  min: number,
  seen: Map<string, number>,
  index: number
): { digits: string; issue: NumberIssue | null } {
  const digits = digitsOnly(raw);
  if (!raw.trim()) return { digits, issue: 'number_required' };
  if (!NUMBER_CHARS.test(raw) || digits.length < min || digits.length > 20)
    return { digits, issue: 'number_invalid' };
  if (seen.has(digits)) return { digits, issue: 'number_duplicate' };
  seen.set(digits, index);
  return { digits, issue: null };
}

export interface RouteDraft {
  didNumber: string;
  nameOnPbx: string;
  accountId: string | null;
}
export interface RouteRowIssues {
  number?: NumberIssue;
  name?: 'name_too_long';
  workspace?: 'workspace_required';
}
export interface RoutesPayload {
  routes: { didNumber: string; nameOnPbx: string | null; accountId: string }[];
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as T;

/**
 * The Phone numbers → workspace list, checked as PUT /api/pbx/routes
 * checks it: 1 to 20 digits each (stored as digits only, so "+971 4…"
 * and "9714…" are the same number and may appear once), a name of at
 * most 100 characters, and a workspace on every row.
 */
export function validateRoutes(
  rows: readonly RouteDraft[]
):
  | { ok: true; payload: RoutesPayload }
  | { ok: false; issues: RouteRowIssues[] } {
  const seen = new Map<string, number>();
  const routes: RoutesPayload['routes'] = [];
  const issues = rows.map((row, i): RouteRowIssues => {
    const { digits, issue } = numberIssue(row.didNumber, 1, seen, i);
    const name = row.nameOnPbx.trim();
    if (row.accountId)
      routes.push({
        didNumber: digits,
        nameOnPbx: name || null,
        accountId: row.accountId,
      });
    return clean({
      number: issue ?? undefined,
      name: name.length > 100 ? ('name_too_long' as const) : undefined,
      workspace: row.accountId ? undefined : ('workspace_required' as const),
    });
  });
  return issues.some((r) => Object.keys(r).length)
    ? { ok: false, issues }
    : { ok: true, payload: { routes } };
}

export interface BankNumberDraft {
  number: string;
  bankCode: string;
}
export interface BankNumberRowIssues {
  number?: NumberIssue;
  bankCode?: 'bank_code_required';
}

/** The Bank numbers list, as PUT /api/pbx/bank-numbers checks it. */
export function validateBankNumbers(rows: readonly BankNumberDraft[]):
  | {
      ok: true;
      payload: { bankNumbers: { number: string; bankCode: string }[] };
    }
  | { ok: false; issues: BankNumberRowIssues[] } {
  const seen = new Map<string, number>();
  const bankNumbers: { number: string; bankCode: string }[] = [];
  const issues = rows.map((row, i): BankNumberRowIssues => {
    const { digits, issue } = numberIssue(row.number, 3, seen, i);
    const code = row.bankCode.trim();
    bankNumbers.push({ number: digits, bankCode: code });
    return clean({
      number: issue ?? undefined,
      bankCode:
        code && code.length <= 32 ? undefined : ('bank_code_required' as const),
    });
  });
  return issues.some((r) => Object.keys(r).length)
    ? { ok: false, issues }
    : { ok: true, payload: { bankNumbers } };
}

// ---------- Recording rules ----------

const wholeIn = (raw: string, min: number, max: number): number | null => {
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/** Empty keeps recordings (null); otherwise 1 to 3650 days. */
export function parseRetentionDays(
  raw: string
): { ok: true; value: number | null } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: null };
  const n = wholeIn(raw, 1, 3650);
  return n === null ? { ok: false } : { ok: true, value: n };
}

/**
 * Saving `next` over the saved period can delete recordings at once (the
 * cron's next run, migration 093): a first period, or a shorter one.
 * Settings then shows how many and asks first. Longer or none deletes
 * nothing now.
 */
export function retentionNeedsConfirm(
  saved: number | null,
  next: number | null
): boolean {
  return next !== null && (saved === null || next < saved);
}

/** The saved period, as GET /api/pbx/settings answers it. */
export interface SavedRetention {
  retentionDays: number | null;
  /**
   * When an owner or admin last saved the period through Settings
   * (093); null: the period deletes nothing yet.
   */
  retentionConfirmedAt: string | null;
}

/** The recording rules card's settings (GET /api/pbx/settings). */
export interface RecordingRules extends SavedRetention {
  storeRecordings: boolean;
  announcementRequired: boolean;
  excludeBankNumbers: boolean;
  missedCallDueMinutes: number;
  mandatoryDisposition: boolean;
  missedCallWhatsappDraft: boolean;
}

/**
 * The period the retention run acts on (093). One saved but never
 * confirmed (stored before 093 enforced it) deletes nothing, so it
 * counts as none: saving it again is a first period.
 */
export function enforcedRetention(saved: SavedRetention): number | null {
  return saved.retentionConfirmedAt ? saved.retentionDays : null;
}

/**
 * Whether saving the rules card sends the period: only when the admin
 * changed it from the one the page loaded, or when that one is not
 * enforced yet (saving it again starts it). Never the loaded period
 * unchanged: another admin may have changed it since, and resending it
 * would quietly undo that.
 */
export function sendsRetention(
  saved: SavedRetention,
  typed: number | null
): boolean {
  return (
    typed !== saved.retentionDays ||
    (typed !== null && enforcedRetention(saved) === null)
  );
}

/**
 * The rules card's PUT /api/pbx/settings body. `confirmed`: the period
 * the admin confirmed deleting under, or that the count showed deletes
 * nothing now; the route refuses a first or shorter period without it
 * (409 confirm_retention).
 */
export function rulesBody(
  rules: RecordingRules,
  typed: number | null,
  minutes: number,
  confirmed?: number
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    storeRecordings: rules.storeRecordings,
    announcementRequired: rules.announcementRequired,
    excludeBankNumbers: rules.excludeBankNumbers,
    mandatoryDisposition: rules.mandatoryDisposition,
    missedCallWhatsappDraft: rules.missedCallWhatsappDraft,
    missedCallDueMinutes: minutes,
  };
  if (sendsRetention(rules, typed)) {
    body.retentionDays = typed;
    if (typed !== null && confirmed === typed)
      body.confirmRetentionDays = typed;
  }
  return body;
}

/** 1 to 1440 minutes. */
export function parseDueMinutes(raw: string): number | null {
  return wholeIn(raw, 1, 1440);
}

// ---------- Connection form ----------

export interface ConnectionDraft {
  label: string;
  edition: PbxEdition;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  sdkAccessId: string;
  sdkAccessKey: string;
  webhookSecret: string;
  clearSdk: boolean;
  clearWebhookSecret: boolean;
}

export type ConnectionField =
  'label' | 'baseUrl' | 'clientId' | 'clientSecret' | 'sdk' | 'webhookSecret';
export type ConnectionIssue =
  | 'label_required'
  | 'base_url_invalid'
  | 'base_url_https'
  | 'base_url_credentials'
  | 'client_id_required'
  | 'client_secret_required'
  | 'sdk_pair'
  | 'webhook_secret_length';

export interface ConnectionPayload {
  label: string;
  edition: PbxEdition;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  sdkAccessId?: string | null;
  sdkAccessKey?: string | null;
  webhookSecret?: string | null;
}

/** Yeastar's webhook push signs with a secret of exactly this length. */
export const WEBHOOK_SECRET_LENGTH = 32;

/**
 * The connection form, checked as PUT /api/pbx/connection checks it,
 * plus the two rules Yeastar imposes: https:// on the Cloud edition and
 * a 32-character webhook secret. A secret left empty is omitted (the
 * stored one is kept); "remove" sends null. The Client ID works the same
 * way once a connection exists (the screen shows only its last 4
 * characters), and a new connection needs one.
 */
export function validateConnectionForm(
  d: ConnectionDraft,
  stored: Pick<
    PbxConnectionView,
    'hasClientSecret' | 'hasSdkCredentials'
  > | null
):
  | { ok: true; payload: ConnectionPayload }
  | { ok: false; issues: Partial<Record<ConnectionField, ConnectionIssue>> } {
  const issues: Partial<Record<ConnectionField, ConnectionIssue>> = {};
  const label = d.label.trim();
  if (!label || label.length > 100) issues.label = 'label_required';

  let origin = '';
  try {
    const url = new URL(d.baseUrl.trim());
    if (url.username || url.password) issues.baseUrl = 'base_url_credentials';
    else if (url.protocol === 'https:') origin = url.origin;
    else if (d.edition === 'cloud') issues.baseUrl = 'base_url_https';
    else if (url.protocol === 'http:') origin = url.origin;
    else issues.baseUrl = 'base_url_invalid';
  } catch {
    issues.baseUrl = 'base_url_invalid';
  }

  const clientId = d.clientId.trim();
  if ((!clientId && !stored) || clientId.length > 200)
    issues.clientId = 'client_id_required';
  const clientSecret = d.clientSecret.trim();
  if (!clientSecret && !stored?.hasClientSecret)
    issues.clientSecret = 'client_secret_required';

  const sdkId = d.sdkAccessId.trim();
  const sdkKey = d.sdkAccessKey.trim();
  if (!d.clearSdk && !stored?.hasSdkCredentials && !sdkId !== !sdkKey)
    issues.sdk = 'sdk_pair';

  const webhookSecret = d.webhookSecret.trim();
  if (
    !d.clearWebhookSecret &&
    webhookSecret &&
    webhookSecret.length !== WEBHOOK_SECRET_LENGTH
  )
    issues.webhookSecret = 'webhook_secret_length';

  if (Object.keys(issues).length) return { ok: false, issues };
  const payload: ConnectionPayload = {
    label,
    edition: d.edition,
    baseUrl: origin,
  };
  if (clientId) payload.clientId = clientId;
  if (clientSecret) payload.clientSecret = clientSecret;
  if (d.clearSdk) {
    payload.sdkAccessId = null;
    payload.sdkAccessKey = null;
  } else {
    if (sdkId) payload.sdkAccessId = sdkId;
    if (sdkKey) payload.sdkAccessKey = sdkKey;
  }
  if (d.clearWebhookSecret) payload.webhookSecret = null;
  else if (webhookSecret) payload.webhookSecret = webhookSecret;
  return { ok: true, payload };
}
