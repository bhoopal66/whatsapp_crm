import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplate, describeSendFailure } from '@/lib/whatsapp/provider'
import { resolveChannelForSurface, ChannelError } from '@/lib/whatsapp/channels'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { headerMediaProblem } from '@/lib/whatsapp/template-send-builder'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send overrides.
   *
   * Under Meta this carried header-variable values, a media override,
   * and URL / COPY_CODE button values, because each had to be encoded
   * into the template's component array. Whapi renders the template
   * locally, so body values come from `params` and the only thing left
   * that genuinely varies per recipient is the header media.
   */
  messageParams?: { headerMediaUrl?: string }
}

/** See the bound in POST. */
const MAX_RECIPIENTS_PER_CALL = 100

/**
 * The server log is readable well beyond the people allowed to see
 * customer numbers, and one failed batch once wrote 98 full numbers to
 * it. The last four digits are enough to match a line to a recipient.
 */
function maskPhone(phone: unknown): string {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : ''
  return digits.length > 4 ? `…${digits.slice(-4)}` : '…'
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls Whapi directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('admin')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    // This one-shot route sends inside the request and persists
    // nothing, so a large list that times out half way leaves no record
    // and a retry messages the first half twice. It was built for the
    // wizard's batches of 10; campaigns go through the recorded,
    // resumable path (broadcast-core / resume / cron). Bound it.
    if (recipients.length > MAX_RECIPIENTS_PER_CALL) {
      return NextResponse.json(
        {
          error: `At most ${MAX_RECIPIENTS_PER_CALL} recipients per call. Create a broadcast for larger sends.`,
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    // Which number this campaign sends from (migration 046). Obeys the
    // admin's `broadcast` route, which is how marketing is pointed at
    // the Cloud API number.
    let channel
    try {
      channel = await resolveChannelForSurface(supabase, accountId, 'broadcast')
    } catch (err) {
      if (err instanceof ChannelError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Load the template row once — it is the message body Whapi will
    // send, rendered per recipient. Loading inside the loop would N+1
    // against Supabase for every recipient. A malformed or missing row
    // fails loudly once rather than as N identical opaque errors.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — open Settings → Templates and re-save it before broadcasting.',
        },
        { status: 500 },
      )
    }
    if (!resolvedTemplate.row) {
      return NextResponse.json(
        { error: `No template named "${template_name}" exists on this account.` },
        { status: 404 },
      )
    }
    const templateRow = resolvedTemplate.row

    // A media header with no media fails every Meta send identically;
    // refuse the batch once rather than returning N copies of it.
    if (channel.provider === 'meta') {
      for (const recipient of recipients) {
        const problem = headerMediaProblem(
          templateRow,
          recipient.messageParams?.headerMediaUrl
        )
        if (problem) {
          return NextResponse.json(
            { error: problem, code: 'template_media_missing' },
            { status: 400 }
          )
        }
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          const result = await sendTemplate({
            channel,
            to: variant,
            template: templateRow,
            bodyParams: recipient.params ?? [],
            // Per-send media override, when the caller supplied one.
            headerMediaUrl: recipient.messageParams?.headerMediaUrl,
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          // Provider-aware, so a Meta rejection is stored against the
          // recipient as "the 24-hour window is closed" rather than a
          // bare numeric code.
          const errorMessage = describeSendFailure(error)
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
          // retry with next variant
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${maskPhone(recipient.phone)}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
