import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { submitMessageTemplate, MetaError } from '@/lib/whatsapp/meta-api';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import { loadChannels } from '@/lib/whatsapp/channels';
import type { TemplateMetaAnswer } from '@/lib/whatsapp/template-save-outcome';
import { isLocalTemplate } from '@/lib/whatsapp/template-submit-row';
import { AuthUnavailableError } from '@/lib/auth/auth-unavailable';

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
 * ─── …and what came back with the Meta number (migration 046) ─────
 *
 * An account can now also connect a Meta Cloud API number, which CAN
 * only send templates that its WABA has approved. So the local save is
 * still the primary job — it is all a Whapi-only install needs, and it
 * must succeed on its own — but when a Meta channel is connected the
 * row is ALSO submitted for review, and the verdict arrives later on
 * the `message_template_status_update` webhook.
 *
 * The submission is best-effort: if Meta rejects the payload the row is
 * still saved and still sendable over Whapi, with the reason stored in
 * `submission_error`. Failing the whole save would throw away the
 * user's work over a constraint that only applies to one of their two
 * numbers.
 *
 * `status` is written as `APPROVED` for a row Meta has not taken, rather
 * than introducing a new enum value: the column's CHECK constraint
 * already allows it, every consumer (the composer's template picker,
 * broadcasts, automations) already gates on it, and it accurately
 * describes the state on a linked number: this template can be sent.
 *
 * ─── Order: refuse, ask Meta, then one write ──────────────────────
 *
 * This route only ever adds a template. Saving over one Meta already has
 * used to drop its Meta id and show it APPROVED, and Meta then refused
 * the duplicate: no Meta chat could send it until the next Sync. So a
 * name and language that are Meta's in this account (an id, or a verdict
 * of Meta's) are a 409 before anything happens, and nothing is written
 * until Meta has answered: a refused row keeps its reason until then.
 *
 * ─── A saved row sent to Meta (`template_id`) ─────────────────────
 *
 * "Submit to Meta" on a row names it, so the answer lands on that row
 * also when a teammate holds one of the same name and language. Only a
 * row of this account with that name and language counts; any other id
 * is refused before Meta is asked, never saved as another row.
 */

interface ExistingRow {
  id: string;
  user_id: string;
  meta_template_id: string | null;
  status: string | null;
}

/** Every row of the account with this name and language, anybody's. */
async function rowsOfThatName(
  supabase: SupabaseClient,
  accountId: string,
  payload: TemplatePayload
): Promise<ExistingRow[]> {
  const { data, error } = await supabase
    .from('message_templates')
    .select('id, user_id, meta_template_id, status')
    .eq('account_id', accountId)
    .eq('name', payload.name)
    .eq('language', payload.language);
  if (error) throw new Error(error.message);
  return (data ?? []) as ExistingRow[];
}

function nameTaken() {
  return NextResponse.json(
    {
      error:
        'A template with this name and language already exists. Edit it, or choose another name.',
      code: 'TEMPLATE_EXISTS',
    },
    { status: 409 }
  );
}

/** The columns a row cannot do without. */
function coreColumns(accountId: string, payload: TemplatePayload) {
  return {
    // Account tenancy — required NOT NULL on message_templates as of
    // migration 017. Without this an INSERT throws on the not-null
    // constraint.
    account_id: accountId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    body_text: payload.body_text,
    last_submitted_at: new Date().toISOString(),
  };
}

function contentColumns(payload: TemplatePayload) {
  return {
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    // Meta's Resumable-Upload handle. Never set under Whapi — media
    // headers are sent by plain URL — but retained so rows created
    // before the provider switch keep their value's column.
    header_handle: null,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    rejection_reason: null,
  };
}

/** What Meta answered. */
type Verdict =
  | { kind: 'taken'; id: string; status: string }
  | { kind: 'refused'; message: string }
  | { kind: 'not_asked'; reason: 'no_meta_number' | 'meta_unavailable' };

interface VerdictColumns {
  status: string;
  meta_template_id?: string;
  submission_error?: string | null;
}

/**
 * The verdict as columns. Not asked: an earlier refusal stays. `local` is
 * the status of a row Meta has not taken: submitting a saved draft does
 * not put it on offer.
 */
function verdictColumns(verdict: Verdict, local: string): VerdictColumns {
  switch (verdict.kind) {
    case 'taken':
      return {
        meta_template_id: verdict.id,
        status: verdict.status,
        submission_error: null,
      };
    case 'refused':
      return { status: local, submission_error: verdict.message };
    case 'not_asked':
      return { status: local };
  }
}

/**
 * One write, to the row named or a new one of the caller's. No row back
 * is "it became Meta's meanwhile" (a Sync, a second submit): only Meta's
 * own answer is written over one. An update leaves the author alone (the
 * unique index is on (user_id, name, language)).
 */
async function writeRow(
  supabase: SupabaseClient,
  rowId: string | undefined,
  userId: string,
  row: ReturnType<typeof coreColumns> & VerdictColumns
) {
  const table = supabase.from('message_templates');
  if (!rowId) {
    return table
      .insert({ ...row, user_id: userId })
      .select()
      .single();
  }
  const update = table
    .update(row)
    .eq('id', rowId)
    .eq('account_id', row.account_id);
  const guarded =
    'meta_template_id' in row ? update : update.is('meta_template_id', null);
  return guarded.select().maybeSingle();
}

export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: `canEditSettings` and
    // the message_templates_insert/update RLS policies (migration 017)
    // both require 'admin'. Resolving account_id off the profile only
    // proves membership, so the explicit role check stays even though
    // this route no longer has an external side effect to guard.
    const { supabase, accountId, userId } = assertSalesAccess(
      await requireRole('admin')
    );

    let payload: TemplatePayload & { template_id?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 }
      );
    }

    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 }
      );
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
        { status: 400 }
      );
    }

    const existing = await rowsOfThatName(supabase, accountId, payload);
    const named = payload.template_id
      ? existing.find((r) => r.id === payload.template_id)
      : undefined;
    if (payload.template_id && !named) {
      return NextResponse.json(
        {
          error: 'This template was deleted or renamed.',
          code: 'TEMPLATE_GONE',
        },
        { status: 404 }
      );
    }
    if (!existing.every(isLocalTemplate)) return nameTaken();
    const targetRow = (rows: ExistingRow[]) =>
      (
        rows.find((r) => r.id === named?.id) ??
        rows.find((r) => r.user_id === userId)
      )?.id;

    // ── Submit to Meta, when a Meta number is connected ───────────
    //
    // Whapi renders a template locally and needs no approval, so the
    // local save below is the whole job for a Whapi-only install and
    // must succeed on its own. But a Meta number can only send an
    // APPROVED template from its WABA's registry, so with one
    // connected the template is also pushed to Meta for review.
    //
    // Best-effort by design: a submission failure still saves the row,
    // usable over Whapi, and reports why rather than discarding the
    // user's work. The verdict arrives later on the
    // `message_template_status_update` webhook.
    let channels: Awaited<ReturnType<typeof loadChannels>> = [];
    let channelsRead = true;
    try {
      channels = await loadChannels(supabase, accountId);
    } catch (err) {
      // Channel lookup failed entirely — the local save still stands.
      channelsRead = false;
      console.warn(
        '[templates/submit] could not check for a Meta channel:',
        err instanceof Error ? err.message : err
      );
    }
    const meta = channels.find((c) => c.provider === 'meta' && c.wabaId);
    // Told to the author: a Meta number that could not be used (not read,
    // or without its WhatsApp Business Account) is not "there is none".
    let verdict: Verdict = {
      kind: 'not_asked',
      reason:
        channelsRead && !channels.some((c) => c.provider === 'meta')
          ? 'no_meta_number'
          : 'meta_unavailable',
    };
    if (meta?.wabaId) {
      try {
        const result = await submitMessageTemplate({
          wabaId: meta.wabaId,
          accessToken: meta.accessToken,
          payload: buildMetaTemplatePayload(payload),
        });
        verdict = {
          kind: 'taken',
          id: result.id,
          // One the column does not allow would fail the write, and the
          // id with it: waiting, as a template just taken is.
          status: normalizeStatus(result.status) ?? 'PENDING',
        };
      } catch (err) {
        verdict = {
          kind: 'refused',
          message:
            err instanceof MetaError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Unknown error submitting to Meta.',
        };
      }
    }

    const core = {
      ...coreColumns(accountId, payload),
      ...verdictColumns(
        verdict,
        named ? (named.status ?? 'DRAFT') : 'APPROVED'
      ),
    };
    const { data: row, error: saveErr } = await writeRow(
      supabase,
      targetRow(existing),
      userId,
      { ...core, ...contentColumns(payload) }
    );

    if (verdict.kind === 'taken' && (saveErr || !row)) {
      // Meta has it now, and a failed write must not lose its id: the
      // smallest row once more, over whatever is there by now. Sync
      // brings the rest from Meta.
      console.error(
        `[templates/submit] saving Meta template ${verdict.id} failed:`,
        saveErr?.message ?? 'the row is gone'
      );
      const now = await rowsOfThatName(supabase, accountId, payload).catch(
        () => existing
      );
      const again = await writeRow(supabase, targetRow(now), userId, core);
      if (again.error) {
        console.error(
          `[templates/submit] Meta template ${verdict.id} is not saved here:`,
          again.error.message
        );
      }
      return NextResponse.json(
        {
          error:
            'Meta accepted this template, but it could not be saved completely here. Press Sync to bring it in.',
          code: 'META_ACCEPTED_NOT_SAVED',
        },
        { status: 500 }
      );
    }
    // Somebody saved the same name between our read and our write.
    if (saveErr?.code === '23505' || (!saveErr && !row)) return nameTaken();
    if (saveErr) {
      return NextResponse.json(
        { error: `Failed to save template: ${saveErr.message}` },
        { status: 500 }
      );
    }

    const metaSubmission: TemplateMetaAnswer =
      verdict.kind === 'taken'
        ? { submitted: true, status: verdict.status }
        : verdict.kind === 'refused'
          ? { submitted: false, error: verdict.message }
          : { submitted: false, reason: verdict.reason };

    return NextResponse.json({
      success: true,
      template: row,
      meta: metaSubmission,
    });
  } catch (error) {
    // Auth failures map to 401/403 before the generic 500 branch —
    // reporting "you aren't an admin" as a template save failure would
    // send the user chasing the wrong problem.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError ||
      error instanceof AuthUnavailableError
    ) {
      return toErrorResponse(error);
    }
    console.error('Error saving template:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save template.',
      },
      { status: 500 }
    );
  }
}
