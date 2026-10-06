import { sendText, sendTemplate } from '@/lib/whatsapp/provider'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/channel-send'
import { resolveBotChannel } from '@/lib/whatsapp/channels'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Whapi sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaChannel({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaChannel({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaChannel(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  // Which number automations send from (migration 046). This obeys the
  // admin's `automation` route rather than following the conversation:
  // routing automations to the marketing number has to hold even when
  // the trigger was an inbound message on the other one. Between two
  // numbers of the same provider it stays on the thread's (migration
  // 060, see resolveBotChannel).
  const channel = await resolveBotChannel(
    db,
    input.accountId,
    'automation',
    input.conversationId,
  )

  // Local template row. Under Whapi this is not merely a bookkeeping
  // lookup when the send goes over Whapi — there the row IS the
  // message, rendered locally, so a missing row means there is nothing
  // to send. On a Meta channel the row instead names an already
  // approved template in the WABA registry.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      if (!templateRow) {
        throw new Error(
          `No local template named "${input.templateName}" for this account`,
        )
      }
      const r = await sendTemplate({
        channel,
        to: phone,
        template: templateRow,
        bodyParams: input.params,
      })
      return r.messageId
    }
    const r = await sendText({
      channel,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — numbers registered
  // with and without a trunk 0 both require this to reliably land a
  // message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // gateway message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  // Templates persist the substituted body, same as the manual and
  // public-API send paths. This was unconditionally null, so every
  // automation template send rendered as an empty bubble (issue #483).
  const content_text =
    input.kind === 'text'
      ? input.text
      : templateContentText(templateRow, input.params ?? [])
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
    // Which number carried it (migration 046).
    provider: channel.provider,
    channel_id: channel.id,
  })
  if (msgErr) {
    // The gateway already has the message; record the DB error but
    // don't pretend the send failed. The engine wraps this in a log line.
    throw new Error(`sent to WhatsApp but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (content_text ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    // Defence in depth: the service-role client bypasses RLS, so never
    // touch a conversation outside the sending account.
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: waMessageId }
}
