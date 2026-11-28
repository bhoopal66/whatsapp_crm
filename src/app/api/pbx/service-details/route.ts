// ============================================================
// /api/pbx/service-details — Settings → Phone system's "Service details
// after a call" card (migration 336). Owners and admins only, as 336's
// SELECT policies and setter RPCs are.
//
// GET answers { settings, map, templates, recent }: the settings (336's
// defaults until the first save), the service map, the workspace's
// approved utility templates (the only ones the sender will use), and
// the last 20 outcomes. PUT saves the settings through
// pbx_service_details_settings_set (which refuses "on" without a
// template). POST adds or edits a map row through pbx_service_map_upsert;
// an edit that changes the match type or value carries `replaces`, the
// old row's id, which is then deleted. DELETE ?id= removes a row.
//
// Written with the caller's own client: the RPCs check the role and
// stamp updated_by themselves.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { DEFAULT_SERVICE_DETAILS_SETTINGS } from '@/lib/pbx/service-details';

type Row = Record<string, unknown>;
type RpcError = { code?: string; hint?: string; message?: string };

const MATCH_TYPES = ['queue', 'did', 'extension'] as const;
const TEMPLATE_NAME = /^[a-z0-9_]{1,100}$/;
const LANGUAGE = /^[a-z]{2}(_[A-Z]{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** 336's HINTs: INVALID is the caller's input, NOT_ALLOWED their role. */
function rpcFailure(what: string, error: RpcError) {
  if (error.hint === 'INVALID' || error.code === '23514')
    return NextResponse.json(
      { error: 'Invalid value', code: 'INVALID' },
      { status: 400 }
    );
  if (error.hint === 'NOT_ALLOWED' || error.code === '42501')
    return NextResponse.json(
      { error: 'Owners and admins only' },
      { status: 403 }
    );
  throw new Error(`${what} failed ${error.code ?? ''}`.trim());
}

const settingsView = (r: Row | null) =>
  r
    ? {
        enabled: r.enabled === true,
        templateName: (r.template_name as string | null) ?? null,
        language: (r.language as string | null) ?? null,
        minSeconds: Number(r.min_seconds ?? 20),
        inbound: r.inbound !== false,
        outbound: r.outbound === true,
      }
    : { ...DEFAULT_SERVICE_DETAILS_SETTINGS };

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const sb = ctx.supabase;
    const [settings, map, templates, recent] = await Promise.all([
      sb
        .from('pbx_service_details_settings')
        .select(
          'enabled, template_name, language, min_seconds, inbound, outbound'
        )
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      sb
        .from('pbx_service_map')
        .select('id, match_type, match_value, label')
        .eq('account_id', ctx.accountId)
        .order('match_value'),
      sb
        .from('message_templates')
        .select('name, language, status, category')
        .eq('account_id', ctx.accountId),
      sb
        .from('pbx_service_details_log')
        .select('call_id, outcome, created_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (settings.error) throw new Error('service details settings read failed');
    if (map.error) throw new Error('service map read failed');
    const seen = new Set<string>();
    const tpl: { name: string; language: string }[] = [];
    for (const r of (templates.data ?? []) as Row[]) {
      const name = String(r.name ?? '');
      const language = String(r.language ?? '');
      if (
        String(r.status ?? '').toLowerCase() !== 'approved' ||
        String(r.category ?? '').toLowerCase() !== 'utility' ||
        !TEMPLATE_NAME.test(name) ||
        !LANGUAGE.test(language) ||
        seen.has(`${name}:${language}`)
      )
        continue;
      seen.add(`${name}:${language}`);
      tpl.push({ name, language });
    }
    tpl.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.language.localeCompare(b.language)
    );
    return NextResponse.json({
      settings: settingsView(settings.data as Row | null),
      map: ((map.data ?? []) as Row[]).map((r) => ({
        id: String(r.id),
        matchType: r.match_type,
        matchValue: r.match_value,
        label: r.label,
      })),
      templates: templates.error ? null : tpl,
      recent: recent.error
        ? null
        : ((recent.data ?? []) as Row[]).map((r) => ({
            callId: String(r.call_id),
            outcome: String(r.outcome),
            at: String(r.created_at),
          })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function body(request: Request): Promise<Row | null> {
  const b = await request.json().catch(() => null);
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Row)
    : null;
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const b = await body(request);
    if (!b) return bad('Invalid JSON body');
    for (const k of ['enabled', 'inbound', 'outbound'])
      if (typeof b[k] !== 'boolean') return bad(`${k} must be true or false`);
    const tpl = b.templateName === null ? null : b.templateName;
    const lang = b.language === null ? null : b.language;
    if (tpl !== null && (typeof tpl !== 'string' || !TEMPLATE_NAME.test(tpl)))
      return bad('templateName must be a template name or null');
    if (lang !== null && (typeof lang !== 'string' || !LANGUAGE.test(lang)))
      return bad('language must be a language code or null');
    const min = b.minSeconds;
    if (
      typeof min !== 'number' ||
      !Number.isInteger(min) ||
      min < 0 ||
      min > 3600
    )
      return bad('minSeconds must be a whole number from 0 to 3600');
    if (b.enabled && tpl === null)
      return NextResponse.json(
        {
          error: 'Choose a template before switching it on',
          code: 'NO_TEMPLATE',
        },
        { status: 400 }
      );
    const { error } = await ctx.supabase.rpc(
      'pbx_service_details_settings_set',
      {
        p_account: ctx.accountId,
        p_enabled: b.enabled,
        p_template_name: tpl,
        p_language: lang,
        p_min_seconds: min,
        p_inbound: b.inbound,
        p_outbound: b.outbound,
      }
    );
    if (error) return rpcFailure('pbx_service_details_settings_set', error);
    return NextResponse.json({
      settings: {
        enabled: b.enabled,
        templateName: tpl,
        language: lang,
        minSeconds: min,
        inbound: b.inbound,
        outbound: b.outbound,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const b = await body(request);
    if (!b) return bad('Invalid JSON body');
    const type = b.matchType;
    const value = typeof b.matchValue === 'string' ? b.matchValue.trim() : '';
    const label =
      typeof b.label === 'string' ? b.label.replace(/\s+/g, ' ').trim() : '';
    if (!MATCH_TYPES.includes(type as (typeof MATCH_TYPES)[number]))
      return bad('matchType must be queue, did or extension');
    if (value.length < 1 || value.length > 64)
      return bad('matchValue must be 1 to 64 characters');
    if (label.length < 1 || label.length > 60)
      return bad('label must be 1 to 60 characters');
    if (
      b.replaces !== undefined &&
      (typeof b.replaces !== 'string' || !UUID.test(b.replaces))
    )
      return bad('replaces must be a row id');
    const { data, error } = await ctx.supabase.rpc('pbx_service_map_upsert', {
      p_account: ctx.accountId,
      p_match_type: type,
      p_match_value: value,
      p_label: label,
    });
    if (error) return rpcFailure('pbx_service_map_upsert', error);
    const id = String(data);
    if (typeof b.replaces === 'string' && b.replaces !== id) {
      const del = await ctx.supabase.rpc('pbx_service_map_delete', {
        p_account: ctx.accountId,
        p_id: b.replaces,
      });
      if (del.error) return rpcFailure('pbx_service_map_delete', del.error);
    }
    return NextResponse.json({
      row: { id, matchType: type, matchValue: value, label },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!UUID.test(id)) return bad('id must be a row id');
    const { data, error } = await ctx.supabase.rpc('pbx_service_map_delete', {
      p_account: ctx.accountId,
      p_id: id,
    });
    if (error) return rpcFailure('pbx_service_map_delete', error);
    return NextResponse.json({ deleted: data === true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
