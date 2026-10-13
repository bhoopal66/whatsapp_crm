// ============================================================
// /api/pbx/settings — the active workspace's phone-system settings
// (pbx_settings, migrations 089 and 090). GET answers the defaults until the
// first save. PUT takes any of { storeRecordings (false: the CRM stops
// downloading recordings; the PBX keeps recording), announcementRequired,
// excludeBankNumbers, retentionDays (null keeps recordings, else
// 1-3650), missedCallDueMinutes (1-1440), mandatoryDisposition,
// missedCallWhatsappDraft }; an omitted field keeps its value.
//
// Admin+, written with the caller's own client: pbx_settings has admin
// RLS, and its trigger stamps updated_by.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

const COLUMNS =
  'store_recordings, announcement_required, exclude_bank_numbers, retention_days, missed_call_due_minutes, mandatory_disposition, missed_call_whatsapp_draft, updated_at, updated_by';
const FLAGS = [
  ['storeRecordings', 'store_recordings'],
  ['announcementRequired', 'announcement_required'],
  ['excludeBankNumbers', 'exclude_bank_numbers'],
  ['mandatoryDisposition', 'mandatory_disposition'],
  ['missedCallWhatsappDraft', 'missed_call_whatsapp_draft'],
] as const;
/** Migrations 089 and 090's column defaults. */
const DEFAULTS: Record<string, unknown> = {
  store_recordings: true,
  announcement_required: true,
  exclude_bank_numbers: true,
  retention_days: null,
  missed_call_due_minutes: 30,
  mandatory_disposition: false,
  missed_call_whatsapp_draft: false,
  updated_at: null,
  updated_by: null,
};

const view = (r: Record<string, unknown>) => ({
  storeRecordings: r.store_recordings,
  announcementRequired: r.announcement_required,
  excludeBankNumbers: r.exclude_bank_numbers,
  retentionDays: r.retention_days,
  missedCallDueMinutes: r.missed_call_due_minutes,
  mandatoryDisposition: r.mandatory_disposition,
  missedCallWhatsappDraft: r.missed_call_whatsapp_draft,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const whole = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function parse(b: Record<string, unknown>): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  for (const [field, column] of FLAGS) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== 'boolean') return `${field} must be true or false`;
    out[column] = b[field];
  }
  if (b.retentionDays !== undefined) {
    if (b.retentionDays !== null && !whole(b.retentionDays, 1, 3650))
      return 'retentionDays must be null (keep recordings) or 1 to 3650';
    out.retention_days = b.retentionDays;
  }
  if (b.missedCallDueMinutes !== undefined) {
    if (!whole(b.missedCallDueMinutes, 1, 1440))
      return 'missedCallDueMinutes must be a whole number from 1 to 1440';
    out.missed_call_due_minutes = b.missedCallDueMinutes;
  }
  return Object.keys(out).length ? out : 'Nothing to change';
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('pbx_settings')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`pbx_settings read failed: ${error.message}`);
    return NextResponse.json({
      settings: view((data as Record<string, unknown> | null) ?? DEFAULTS),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const fields = parse(body as Record<string, unknown>);
    if (typeof fields === 'string')
      return NextResponse.json({ error: fields }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from('pbx_settings')
      .upsert(
        { account_id: ctx.accountId, ...fields },
        { onConflict: 'account_id' }
      )
      .select(COLUMNS)
      .single();
    if (error || !data)
      throw new Error(`pbx_settings write failed: ${error?.message}`);
    return NextResponse.json({
      settings: view(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
