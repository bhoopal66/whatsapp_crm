// ============================================================
// /api/pbx/settings — the active workspace's phone-system settings
// (pbx_settings, migrations 089 and 090). GET answers the defaults until the
// first save. PUT takes any of { storeRecordings (false: the CRM stops
// downloading recordings; the PBX keeps recording), announcementRequired,
// excludeBankNumbers, retentionDays (null keeps recordings, else
// 1-3650), missedCallDueMinutes (1-1440), mandatoryDisposition,
// missedCallWhatsappDraft }; an omitted field keeps its value.
//
// The retention period deletes recordings on the next cron run (093),
// and only once confirmed: saving a period stamps
// retention_confirmed_at, clearing it clears both. A first period, or
// one shorter than the period in force (a saved one never confirmed
// counts as none), is refused with 409 { code: 'confirm_retention' }
// unless the body carries confirmRetentionDays equal to it, which
// Settings sends after the admin saw how many recordings it deletes.
// The check is the write itself: without the confirmation the update
// applies only while the period in force is still no longer than the
// new one, so a period another admin lengthened since this page loaded
// is never shortened unasked. retentionNeedsConfirm (admin-ui.ts) is
// the screen's side of the rule.
//
// Written with the caller's own client: pbx_settings has admin RLS, and
// its trigger stamps updated_by. Admin+, except mandatoryDisposition,
// which team leaders may also switch (§7.3, migration 097): a leader's
// PUT may carry only that field, and goes through
// pbx_set_mandatory_disposition(), which changes nothing else.
//
// GET answers retentionConfirmedAt (null: the period deletes nothing
// yet) and `recordings`, what the workspace keeps now
// (pbx_recordings_kept, migration 093): { kept, legalHold, oldestCallAt,
// expired } by call date, or null when it cannot be read, which never
// keeps the settings from loading. A team leader, who may read the
// settings, always gets null: the function is admin-only.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import { fail } from '@/lib/pbx/calls';

const COLUMNS =
  'store_recordings, announcement_required, exclude_bank_numbers, retention_days, retention_confirmed_at, missed_call_due_minutes, mandatory_disposition, missed_call_whatsapp_draft, updated_at, updated_by';
const FLAGS = [
  ['storeRecordings', 'store_recordings'],
  ['announcementRequired', 'announcement_required'],
  ['excludeBankNumbers', 'exclude_bank_numbers'],
  ['mandatoryDisposition', 'mandatory_disposition'],
  ['missedCallWhatsappDraft', 'missed_call_whatsapp_draft'],
] as const;
/** Migrations 089, 090 and 093's column defaults. */
const DEFAULTS: Record<string, unknown> = {
  store_recordings: true,
  announcement_required: true,
  exclude_bank_numbers: true,
  retention_days: null,
  retention_confirmed_at: null,
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
  retentionConfirmedAt: r.retention_confirmed_at ?? null,
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

async function kept(sb: SupabaseClient) {
  const { data, error } = await sb.rpc('pbx_recordings_kept');
  const r = data as Record<string, unknown> | null;
  if (error || !r) {
    console.error(
      '[GET /api/pbx/settings] pbx_recordings_kept:',
      error?.message
    );
    return null;
  }
  return {
    kept: Number(r.kept ?? 0),
    legalHold: Number(r.legal_hold ?? 0),
    oldestCallAt:
      typeof r.oldest_call_at === 'string' ? r.oldest_call_at : null,
    expired: Number(r.expired ?? 0),
  };
}

export async function GET() {
  try {
    const ctx = await requireRole('team_leader');
    const { data, error } = await ctx.supabase
      .from('pbx_settings')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`pbx_settings read failed: ${error.message}`);
    return NextResponse.json({
      settings: view((data as Record<string, unknown> | null) ?? DEFAULTS),
      recordings: canEditSettings(ctx.role) ? await kept(ctx.supabase) : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('team_leader');
    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const b = body as Record<string, unknown>;
    const fields = parse(b);
    if (typeof fields === 'string')
      return NextResponse.json({ error: fields }, { status: 400 });
    if (!canEditSettings(ctx.role)) {
      if (Object.keys(fields).some((k) => k !== 'mandatory_disposition'))
        return NextResponse.json(
          {
            error:
              'Only an admin can change phone settings other than mandatory outcomes',
          },
          { status: 403 }
        );
      const set = await ctx.supabase.rpc('pbx_set_mandatory_disposition', {
        p_on: fields.mandatory_disposition,
      });
      if (set.error)
        throw new Error(`pbx_settings write failed: ${set.error.message}`);
      const { data, error } = await ctx.supabase
        .from('pbx_settings')
        .select(COLUMNS)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) throw new Error(`pbx_settings read failed: ${error.message}`);
      return NextResponse.json({
        settings: view((data as Record<string, unknown> | null) ?? DEFAULTS),
      });
    }
    const next = fields.retention_days;
    if (next !== undefined) {
      fields.retention_confirmed_at =
        next === null ? null : new Date().toISOString();
      if (typeof next === 'number' && b.confirmRetentionDays !== next) {
        const { data, error } = await ctx.supabase
          .from('pbx_settings')
          .update(fields)
          .eq('account_id', ctx.accountId)
          .not('retention_confirmed_at', 'is', null)
          .lte('retention_days', next)
          .select(COLUMNS)
          .maybeSingle();
        if (error)
          throw new Error(`pbx_settings write failed: ${error.message}`);
        if (!data)
          return fail(
            'A first or shorter retention period deletes recordings: confirm it first',
            409,
            { code: 'confirm_retention', retentionDays: next }
          );
        return NextResponse.json({
          settings: view(data as Record<string, unknown>),
        });
      }
    }
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
