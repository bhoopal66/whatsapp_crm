import { NextResponse } from 'next/server'
import {
  assertSalesAccess,
  ForbiddenError,
  getCurrentAccount,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { AuthUnavailableError } from '@/lib/auth/auth-unavailable';

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit a template. Takes effect on the next send.
 * DELETE — remove the template.
 *
 * ─── What changed with Whapi ──────────────────────────────────────
 *
 * Under Meta these were two-phase operations against a remote
 * registry: an edit replaced the template's components on the
 * WhatsApp Business Account and reset it to PENDING for another
 * review, and a delete had to remove the remote HSM before dropping
 * the local row — with a data-drift failure mode in between where the
 * remote call succeeded and the local write didn't.
 *
 * A Whapi channel has no template registry. A template is a local row
 * that `sendTemplateMessage` renders at send time, so both operations
 * are now single, ordinary database writes: no remote call, no
 * PENDING limbo, no drift to recover from, and an edit is live
 * immediately.
 *
 * The `status` column stays APPROVED throughout (see the /submit
 * route for why that value) — every consumer already gates on it.
 */

// uuid v4 plus the looser shape Postgres gen_random_uuid emits. We
// don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid template id.' }, { status: 400 })
    }

    const { supabase, accountId } = assertSalesAccess(
      await getCurrentAccount(),
    )

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    // RLS handles ownership, but confirming the row exists in THIS
    // account turns a silent no-op update into an honest 404.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    // Same guard as /submit: a media header with no URL would fail on
    // every send, so reject it while the author can still fix it.
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

    const { data: row, error: updErr } = await supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        // Edits are live immediately — there is nothing to review.
        status: 'APPROVED',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        { error: `Failed to save template: ${updErr.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, template: row })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError || error instanceof AuthUnavailableError) {
      return toErrorResponse(error)
    }
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid template id.' }, { status: 400 })
    }

    const { supabase, accountId } = assertSalesAccess(
      await getCurrentAccount(),
    )

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)

    if (delErr) {
      return NextResponse.json(
        { error: `Failed to delete template: ${delErr.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError || error instanceof AuthUnavailableError) {
      return toErrorResponse(error)
    }
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}
