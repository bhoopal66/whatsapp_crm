import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
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
 * time.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
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

    const remote = await listMessageTemplates({
      wabaId: meta.wabaId,
      accessToken: meta.accessToken,
    });

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
        updated++;
      } else {
        const { error } = await supabase
          .from('message_templates')
          .insert({ ...row, account_id: accountId, user_id: userId });
        if (error) throw error;
        created++;
      }
    }

    return NextResponse.json({
      success: true,
      total: remote.length,
      created,
      updated,
      skipped,
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
