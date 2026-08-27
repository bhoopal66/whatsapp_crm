import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'

/**
 * POST /api/whatsapp/templates/submit — save a message template.
 *
 * ─── What changed with Whapi ──────────────────────────────────────
 *
 * Under Meta this route was a *submission*: it POSTed the template to
 * the WhatsApp Business Account, waited for a review verdict, stored a
 * `meta_template_id`, and left the row PENDING until a webhook came
 * back APPROVED or REJECTED. Sends outside the 24-hour window were only
 * possible with an approved template, so that round-trip gated real work.
 *
 * Whapi channels ride an ordinary WhatsApp account. There is no
 * template registry, no review, no category policy, and no 24-hour
 * window — a template here is simply a reusable message definition that
 * the CRM renders locally and sends as a normal message (see
 * `sendTemplateMessage` in `whapi-api.ts`).
 *
 * So this endpoint is now a plain validated upsert, and a saved
 * template is usable immediately. `status` is written as `APPROVED`
 * rather than introducing a new enum value: the column's CHECK
 * constraint already allows it, every consumer (the composer's template
 * picker, broadcasts, automations) already gates on it, and it
 * accurately describes the state — this template can be sent.
 *
 * The Meta-era columns (`meta_template_id`, `submission_error`,
 * `rejection_reason`) are left NULL. They stay on the table so an
 * existing install's history survives the provider switch.
 */

/**
 * Shared upsert payload builder. Kept as its own function so adding a
 * column later touches one place.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as of
    // migration 017. Without this an INSERT throws on the not-null
    // constraint.
    account_id: accountId,
    // Original author — audit only. The unique index is still on
    // (user_id, name, language); see the upsert helper.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    // Meta's Resumable-Upload handle. Never set under Whapi — media
    // headers are sent by plain URL — but retained so rows created
    // before the provider switch keep their value's column.
    header_handle: null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    // Immediately sendable — nothing to wait for.
    status: 'APPROVED',
    meta_template_id: null,
    submission_error: null,
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>,
) {
  // TODO(account-sharing): conflict target is still scoped to user_id.
  // Once a follow-up migration drops the legacy unique index on
  // (user_id, name, language) and adds (account_id, name, language),
  // switch `onConflict` here so two teammates can't shadow each
  // other's same-named template.
  return supabase
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single()
}

export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: `canEditSettings` and
    // the message_templates_insert/update RLS policies (migration 017)
    // both require 'admin'. Resolving account_id off the profile only
    // proves membership, so the explicit role check stays even though
    // this route no longer has an external side effect to guard.
    const { supabase, accountId, userId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    // A media header is sent to Whapi as a plain URL at send time, so a
    // template that declares one but carries no URL would fail on every
    // send. Catch it here, where the author can still fix it.
    if (
      payload.header_type &&
      payload.header_type !== 'text' &&
      !payload.header_media_url &&
      !payload.header_content
    ) {
      return NextResponse.json(
        {
          error: `A ${payload.header_type} header needs a media URL. Upload the file or paste a public link.`,
        },
        { status: 400 },
      )
    }

    const { data: row, error: upsertErr } = await upsertTemplateRow(
      supabase,
      buildUpsertRow(accountId, userId, payload),
    )

    if (upsertErr) {
      return NextResponse.json(
        { error: `Failed to save template: ${upsertErr.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, template: row })
  } catch (error) {
    // Auth failures map to 401/403 before the generic 500 branch —
    // reporting "you aren't an admin" as a template save failure would
    // send the user chasing the wrong problem.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error saving template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save template.',
      },
      { status: 500 },
    )
  }
}
