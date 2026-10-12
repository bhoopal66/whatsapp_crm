import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { DEFAULT_COPY } from '@/lib/journeys/host/copy';
import { fail, isRecord } from '../run-event';

const COLUMNS =
  'enabled, workflow_key, start_on_first_inbound, taamul_did, copy, updated_at';

interface SettingsRow {
  enabled: boolean;
  workflow_key: string;
  start_on_first_inbound: boolean;
  taamul_did: string | null;
  copy: Record<string, unknown>;
  updated_at: string | null;
}

const toJson = (row: SettingsRow | null) => ({
  enabled: row?.enabled ?? false,
  workflowKey: row?.workflow_key ?? null,
  startOnFirstInbound: row?.start_on_first_inbound ?? false,
  taamulDid: row?.taamul_did ?? null,
  copy: row?.copy ?? {},
  updatedAt: row?.updated_at ?? null,
});

/** The CHECK on journey_settings.taamul_did (migration 086). */
const E164 = /^\+[1-9][0-9]{6,14}$/;

const allStrings = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((s) => typeof s === 'string');

/**
 * `copy` is the account's overrides of the default session copy
 * (`DEFAULT_COPY`, merged key by key by `mergeCopy`):
 * `{ messages?: { <template>: { body?, buttonLabel?, variants?: {…} } },
 * titles?: { <payload>: title } }`, every leaf a string.
 */
function copyError(copy: unknown): string | null {
  if (!isRecord(copy)) return 'copy must be an object';
  for (const key of Object.keys(copy))
    if (key !== 'messages' && key !== 'titles')
      return `copy.${key} is not a copy section (messages, titles)`;
  if (copy.titles !== undefined && !allStrings(copy.titles))
    return 'copy.titles must map each button to a text';
  if (copy.messages === undefined) return null;
  if (!isRecord(copy.messages)) return 'copy.messages must be an object';
  for (const [name, m] of Object.entries(copy.messages)) {
    if (!isRecord(m)) return `copy.messages.${name} must be an object`;
    for (const [k, v] of Object.entries(m)) {
      const ok =
        k === 'variants'
          ? allStrings(v)
          : (k === 'body' || k === 'buttonLabel') && typeof v === 'string';
      if (!ok) return `copy.messages.${name}.${k} is not valid`;
    }
  }
  return null;
}

/** The account's journey bot settings (any member), with the default copy the overrides apply to. */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { data, error } = await supabase
      .from('journey_settings')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`journey_settings: ${error.message}`);
    return Response.json({
      settings: toJson(data as SettingsRow | null),
      defaultCopy: DEFAULT_COPY,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Admins: `{ enabled?, startOnFirstInbound?, taamulDid?, copy? }`; only
 * the fields sent change. `taamulDid` is E.164 (`+9714…`; spaces and
 * dashes are ignored), empty or null to clear. `copy` replaces the
 * account's whole override object.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body)) return fail(400, 'Expected a JSON object');

    const row: Record<string, unknown> = {};
    for (const [key, col] of [
      ['enabled', 'enabled'],
      ['startOnFirstInbound', 'start_on_first_inbound'],
    ] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean')
        return fail(400, `${key} must be true or false`);
      row[col] = body[key];
    }
    if (body.taamulDid !== undefined) {
      if (body.taamulDid !== null && typeof body.taamulDid !== 'string')
        return fail(400, 'taamulDid must be a phone number');
      const did = (body.taamulDid ?? '').replace(/[\s-]/g, '');
      if (did && !E164.test(did))
        return fail(
          400,
          'taamulDid must be an international number such as +97141234567'
        );
      row.taamul_did = did || null;
    }
    if (body.copy !== undefined) {
      const why = copyError(body.copy);
      if (why) return fail(400, why);
      row.copy = body.copy;
    }
    if (!Object.keys(row).length) return fail(400, 'Nothing to update');

    const { data, error } = await supabase
      .from('journey_settings')
      .upsert({ account_id: accountId, ...row }, { onConflict: 'account_id' })
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`journey_settings: ${error.message}`);
    return Response.json({ settings: toJson(data as SettingsRow | null) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
