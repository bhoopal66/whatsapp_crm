import { NextResponse } from 'next/server';
import {
  requireRole,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import { loadChannels } from '@/lib/whatsapp/channels';
import { listMessageTemplates, MetaError } from '@/lib/whatsapp/meta-api';
import { metaTemplateToRow } from '@/lib/whatsapp/template-import';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/templates/sync — pull the WABA's template registry
 * into `message_templates`.
 *
 * A template built in Meta Business Manager is approved and sendable on
 * the Cloud API number, but the CRM never heard of it: until now the
 * only way a row got here was by submitting it from this app. So an
 * account that did its template work on Meta's side saw an empty list
 * and no way to start a broadcast. This reads the registry and upserts
 * every template that has a body.
 *
 * Matching: by `meta_template_id` first (a row this app submitted, or a
 * previous sync), then by (account, name, language) so a template that
 * was created here before it was submitted is adopted rather than
 * duplicated. New rows are owned by whoever pressed Sync.
 *
 * Meta is the source of truth for status, so an APPROVED / REJECTED /
 * PAUSED verdict overwrites the local one — the same thing the
 * `message_template_status_update` webhook does, one template at a
 * time. A template Meta no longer has is set DISABLED, so no sender
 * offers it: its deletion reaches us only through that webhook, and
 * before this a missed one stayed APPROVED here for good.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = assertSalesAccess(
      await requireRole('admin')
    );
    const limit = checkRateLimit(
      `template-sync:${accountId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const channels = await loadChannels(supabase, accountId);
    const meta = channels.find((c) => c.provider === 'meta' && c.wabaId);
    if (!meta?.wabaId) {
      return NextResponse.json(
        {
          error:
            'No Meta Cloud API number is connected — templates are synced from its WhatsApp Business Account.',
        },
        { status: 400 }
      );
    }

    // Read before the list: a template submitted while Meta is being
    // read is in neither, and must not look deleted.
    const { data: before, error: beforeErr } = await supabase
      .from('message_templates')
      .select('id, meta_template_id, status')
      .eq('account_id', accountId);
    if (beforeErr) throw beforeErr;
    // Not `channels`: it leaves out a number it cannot decrypt, and that
    // number's WABA may be where a template we miss here lives.
    const { data: metaRows, error: metaErr } = await supabase
      .from('whatsapp_config')
      .select('waba_id')
      .eq('account_id', accountId)
      .eq('provider', 'meta');
    if (metaErr) throw metaErr;

    const { templates: remote, complete } = await listMessageTemplates({
      wabaId: meta.wabaId,
      accessToken: meta.accessToken,
    });

    // Read again after it, so a row added meanwhile is matched, not
    // inserted twice.
    const { data: existing, error: listErr } = await supabase
      .from('message_templates')
      .select('id, name, language, meta_template_id')
      .eq('account_id', accountId);
    if (listErr) throw listErr;

    const byMetaId = new Map<string, string>();
    const byNameLang = new Map<string, string>();
    for (const row of existing ?? []) {
      if (row.meta_template_id) byMetaId.set(row.meta_template_id, row.id);
      byNameLang.set(`${row.name} ${row.language ?? ''}`, row.id);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const touched = new Set<string>();
    for (const t of remote) {
      const row = metaTemplateToRow(t);
      if (!row) {
        skipped++;
        continue;
      }
      const id =
        byMetaId.get(row.meta_template_id) ??
        byNameLang.get(`${row.name} ${row.language}`);
      if (id) {
        const { error } = await supabase
          .from('message_templates')
          .update({ ...row, submission_error: null })
          .eq('id', id)
          .eq('account_id', accountId);
        if (error) throw error;
        touched.add(id);
        updated++;
      } else {
        const { error } = await supabase
          .from('message_templates')
          .insert({ ...row, account_id: accountId, user_id: userId });
        if (error) throw error;
        created++;
      }
    }

    // Templates have no WABA of their own here, so a missing one means
    // deleted only when this WABA is the account's only one, and only
    // against a list known to be whole.
    const wabas = new Set((metaRows ?? []).map((r) => r.waba_id));
    const oneWaba = wabas.size === 1 && wabas.has(meta.wabaId);
    let disabled = 0;
    if (oneWaba && complete && remote.length > 0) {
      // Every remote id, the body-less `skipped` ones included.
      const remoteIds = new Set(remote.map((t) => t.id));
      for (const row of before ?? []) {
        if (!row.meta_template_id || remoteIds.has(row.meta_template_id)) {
          continue;
        }
        if (touched.has(row.id) || row.status === 'DISABLED') continue;
        // Submitted seconds ago, Meta's list may not have it yet, and no
        // sender offers it.
        if (row.status === 'PENDING') continue;
        // The id again: a row resubmitted meanwhile carries a new one.
        const { data, error } = await supabase
          .from('message_templates')
          .update({ status: 'DISABLED' })
          .eq('id', row.id)
          .eq('account_id', accountId)
          .eq('meta_template_id', row.meta_template_id)
          .select('id');
        if (error) throw error;
        disabled += data?.length ?? 0;
      }
    }

    return NextResponse.json({
      success: true,
      total: remote.length,
      created,
      updated,
      skipped,
      disabled,
    });
  } catch (err) {
    if (err instanceof MetaError) {
      return NextResponse.json(
        { error: `Meta rejected the request: ${err.message}` },
        { status: 502 }
      );
    }
    return toErrorResponse(err);
  }
}
