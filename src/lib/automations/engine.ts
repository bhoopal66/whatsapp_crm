import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationStepType,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  ChatTagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  SetChatTagStepConfig,
  PostTeamChatStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { salesAnswersOff, type SalesChatCheck } from '@/lib/ai/not-sales-chat'
import { judgeMeanings, loadMeaningTurns, meaningCandidate } from '@/lib/insights/meaning'
import { writeConversationChatTags } from '@/lib/chat-tags/server'
import { chatTagTriggerMatches } from '@/lib/chat-tags/trigger-match'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './channel-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { consentRefusal } from '@/lib/whatsapp/send-origin'
import { isDeliverableUrl, safeFetch } from '@/lib/webhooks/ssrf'
import { automationPoolKey, rotateAssign } from '@/lib/assignment/rotation'
import { isInTimeRange } from './schedule'
import {
  clipTeamChatBody,
  describeTeamChatPostError,
  neutraliseTeamChatValue,
  teamChatChannelRefusal,
  teamChatGuestRefusal,
} from './team-chat-post'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /** The inbound's gateway message id, for intent_match: the memo key
   *  that lets Flows and automations share one Jev request. */
  message_id?: string
  /** The chat's main tag after the change, for chat_tag_set. */
  chat_tag_id?: string | null
  /** The chat's sub-tag after the change, for chat_tag_set. */
  chat_sub_tag_id?: string | null
  /** The chat's main tag before the change, for chat_tag_set. */
  previous_chat_tag_id?: string | null
  /** The chat's sub-tag before the change, for chat_tag_set. */
  previous_chat_sub_tag_id?: string | null
  /** Why this run's message steps stay off after a wait: its message came
   *  in on a chat that is not a sales chat. It can only withhold a send. */
  sales_answers_off?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
  /** The customer's own inbound message is being handled right now. Set
   *  ONLY by the inbound pipeline: it lets a message step answer a
   *  contact who opted out, because they just wrote (never one marked do
   *  not contact). Absent (a tag
   *  change, a manual POST, a resumed wait) an opted-out contact is sent
   *  nothing. Not part of `context`, which is caller-supplied and is
   *  stored with a parked wait. */
  customerJustWrote?: boolean
  /** The inbound pipeline's one decision whether the message's chat is a
   *  sales chat. In any other (HR, another department, or a check that
   *  could not be read) message steps are skipped; the rest still runs. */
  salesChat?: SalesChatCheck | null
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<boolean> {
  // Whether any automation matched and started executing: the inbound
  // pipeline skips intent_match when a keyword_match automation acted.
  // For intent_match, whether it sent the customer something: the AI
  // stands down for that, not for one that only tagged or failed.
  let executed = false
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return false
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return false
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return false
    }
    if (!automations || automations.length === 0) return false

    // intent_match runs at most ONE automation per message: two that
    // both "mean" the text would otherwise both act on the customer.
    const toRun =
      input.triggerType === 'intent_match'
        ? pickIntentAutomations(
            automations as Automation[],
            await judgeIntentAutomations(input, automations as Automation[]),
          )
        : (automations as Automation[]).filter((a) => triggerMatches(a, input.context))

    for (const automation of toRun) {
      if (input.triggerType !== 'intent_match') executed = true
      try {
        if (await executeAutomation(automation, input)) executed = true
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
  return executed
}

/**
 * The one intent_match automation to run: the highest p among those
 * that cleared their own threshold (`matched`, keyed `automation:<id>`);
 * a tie goes to the most recently updated, then the larger id, as
 * `pickIntentFlow` does for flows.
 */
export function pickIntentAutomations(
  automations: Automation[],
  matched: Map<string, number>,
): Automation[] {
  let best: Automation | null = null
  let bestP = -1
  for (const a of automations) {
    const p = matched.get(`automation:${a.id}`)
    if (p === undefined) continue
    const au = a.updated_at ?? ''
    const bu = best?.updated_at ?? ''
    const newer = best !== null && p === bestP && (au > bu || (au === bu && a.id > best.id))
    if (p > bestP || newer) {
      best = a
      bestP = p
    }
  }
  return best ? [best] : []
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  /** The wait the run is parked at (269). Null on a row parked before. */
  wait_step_id?: string | null
  /** How often this row was released after a failed read (269). */
  attempts?: number | null
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .maybeSingle()

  // Every read the run starts from comes before its first step, so a
  // failed one can be tried again: nothing was sent.
  if (error) return releasePending(pending, 'automation', error)
  // Switched off (or deleted) while this run was parked: whoever is
  // waiting gets nothing more. Neither status CHECK (006) allows
  // 'cancelled', so the row settles as 'failed' (it did not run) and the
  // log stays 'partial' with the reason.
  if (!(automation as Automation | null)?.is_active) {
    await finalizeLog(pending.log_id, 'partial', STOPPED_SWITCHED_OFF)
    await markPending(pending.id, 'failed')
    return
  }

  if (pending.contact_id) {
    const { error: contactErr } = await db
      .from('contacts')
      .select('id')
      .eq('id', pending.contact_id)
      .eq('account_id', pending.account_id)
      .maybeSingle()
    if (contactErr) return releasePending(pending, 'contact', contactErr)
  }
  const { data: steps, error: stepsErr } = await loadSteps(pending.automation_id)
  if (stepsErr) return releasePending(pending, 'steps', stepsErr)
  const { data: log, error: runLogErr } = pending.log_id
    ? await db
        .from('automation_logs')
        .select('steps_executed, status')
        .eq('id', pending.log_id)
        .maybeSingle()
    : { data: null, error: null }
  if (runLogErr) return releasePending(pending, 'log', runLogErr)
  const frames = resumeFrames(steps, pending)
  if (!frames) {
    await finalizeLog(pending.log_id, 'failed', STOPPED_CHANGED)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    const outcome = await runFrames(
      {
        automation: automation as Automation,
        contactId: pending.contact_id,
        context: pending.context ?? {},
        logId: pending.log_id,
        triggerEvent: 'resumed_wait',
        // However short the wait, this is no longer a direct answer.
        customerJustWrote: false,
        steps,
        // A step runs at most once per run, also when the wait was moved
        // above steps that already ran.
        alreadyRun: new Set(
          ((log?.steps_executed as AutomationLogStepResult[] | undefined) ?? []).map(
            (r) => r.step_id,
          ),
        ),
        results: [],
        errorMessage: null,
      },
      frames,
    )
    await markPending(pending.id, outcome === 'failed' ? 'failed' : 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

/** Answers whether a step sent the customer something. */
async function executeAutomation(
  automation: Automation,
  input: DispatchInput,
): Promise<boolean> {
  const db = supabaseAdmin()
  const results: AutomationLogStepResult[] = []

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return false
  }

  const { data: steps, error: stepsErr } = await loadSteps(automation.id)
  if (stepsErr) {
    await finalizeLog(log.id, 'failed', stepsErr.message)
  } else {
    await runFrames(
      {
        automation,
        contactId: input.contactId ?? null,
        context: input.context ?? {},
        logId: log.id,
        triggerEvent: input.triggerType,
        customerJustWrote: input.customerJustWrote === true,
        salesChat: input.salesChat ?? null,
        steps,
        alreadyRun: new Set(),
        results,
        errorMessage: null,
      },
      [{ parentStepId: null, branch: null, startPosition: 0 }],
    )
  }

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
  return results.some((r) => r.status === 'success' && CUSTOMER_STEPS.has(r.step_type))
}

/** Steps the customer sees. */
const CUSTOMER_STEPS: ReadonlySet<string> = new Set<AutomationStepType>([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
])

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  logId: string | null
  triggerEvent: string
  /** See DispatchInput.customerJustWrote. */
  customerJustWrote: boolean
  /** See DispatchInput.salesChat; null in a resumed run, whose answer is
   *  `context.sales_answers_off`. */
  salesChat?: SalesChatCheck | null
}

/** One run of an automation: its steps as they were when it (re)started. */
interface Run extends ExecuteArgs {
  steps: AutomationStep[]
  /** Steps an earlier part of this run (before a wait) already took. */
  alreadyRun: ReadonlySet<string>
  results: AutomationLogStepResult[]
  errorMessage: string | null
}

/** A place in the tree: one step list and where to continue in it. */
interface Frame {
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
}

type RunOutcome = 'done' | 'suspended' | 'failed'

async function loadSteps(automationId: string): Promise<{
  data: AutomationStep[]
  error: { message: string } | null
}> {
  const { data, error } = await supabaseAdmin()
    .from('automation_steps')
    .select('*')
    .eq('automation_id', automationId)
    .order('position', { ascending: true })
  return { data: (data ?? []) as AutomationStep[], error }
}

/**
 * Where a parked run continues: the rest of the wait's own list, then
 * what follows each enclosing condition, up to the root. Null when the
 * wait (or, on an old row, its branch) is gone: the automation changed,
 * and any other place would be the wrong one.
 *
 * A row parked before 269 has no `wait_step_id`. Its run already took the
 * steps after the condition (that was the bug), so it finishes its own
 * list only. Its `parent_step_id` goes NULL with the condition while
 * `branch` stays, which is how a lost one is told from the root.
 */
function resumeFrames(
  steps: AutomationStep[],
  pending: {
    wait_step_id?: string | null
    parent_step_id: string | null
    branch: 'yes' | 'no' | null
    next_step_position: number
  },
): Frame[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]))
  if (!pending.wait_step_id) {
    if (pending.parent_step_id ? !byId.has(pending.parent_step_id) : pending.branch) return null
    return [
      {
        parentStepId: pending.parent_step_id,
        branch: pending.branch,
        startPosition: pending.next_step_position,
      },
    ]
  }
  let at = byId.get(pending.wait_step_id)
  if (at?.step_type !== 'wait') return null
  const frames: Frame[] = []
  while (at) {
    frames.push({
      parentStepId: at.parent_step_id ?? null,
      branch: at.branch ?? null,
      startPosition: at.position + 1,
    })
    if (!at.parent_step_id) return frames
    at = byId.get(at.parent_step_id)
  }
  return null
}

/** Run each list in turn and settle the log. */
async function runFrames(run: Run, frames: Frame[]): Promise<RunOutcome> {
  let outcome: RunOutcome = 'done'
  for (const frame of frames) {
    outcome = await runStepList(run, frame)
    if (outcome !== 'done') break
  }
  await appendResults(
    run.logId,
    run.results,
    outcome === 'done' ? 'success' : outcome === 'suspended' ? 'partial' : 'failed',
    run.errorMessage,
  )
  return outcome
}

async function runStepList(args: Run, frame: Frame): Promise<RunOutcome> {
  const db = supabaseAdmin()
  const { results } = args

  for (const step of args.steps) {
    if ((step.parent_step_id ?? null) !== frame.parentStepId) continue
    if (frame.parentStepId !== null && step.branch !== (frame.branch ?? 'yes')) continue
    if (step.position < frame.startPosition || args.alreadyRun.has(step.id)) continue

    // `wait` is the suspension point: enqueue and suspend the whole run.
    // The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      // Kept for the resumed run, which has no inbound message to ask about.
      const salesOff = await notSalesReason(args)
      const { error: waitErr } = await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: frame.parentStepId,
        branch: frame.branch,
        next_step_position: step.position + 1,
        wait_step_id: step.id,
        context: salesOff ? { ...args.context, sales_answers_off: salesOff } : args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      if (waitErr) {
        console.error('[automations] wait insert failed:', args.automation.id, waitErr)
        // Nothing is parked, so nothing will resume: a failed step.
        args.errorMessage = 'wait: the wait could not be saved'
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'failed',
          detail: args.errorMessage,
        })
        return 'failed'
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      return 'suspended'
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const outcome = await runStepList(args, {
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
        })
        // A wait in the branch parks the steps after the condition too.
        if (outcome !== 'done') return outcome
        continue
      }

      const skipReason =
        (await notSalesSkipReason(step, args)) ?? (await optOutSkipReason(step, args))
      if (skipReason) {
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'skipped',
          detail: skipReason,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      args.errorMessage = msg
      return 'failed'
    }
  }
  return 'done'
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  // Contact tags are retired; an automation saved before that still
  // carries these steps. They do nothing rather than fail the run.
  if (RETIRED_STEP_TYPES.has(step.step_type)) {
    console.warn('[automations] skipping retired contact-tag step', {
      automationId: args.automation.id,
      stepType: step.step_type,
    })
    return `retired step ${step.step_type} skipped`
  }

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'set_chat_tag': {
      const cfg = step.step_config as SetChatTagStepConfig
      if (!args.contactId) throw new Error('set_chat_tag needs a contact')
      // null clears the chat's tags; a missing or empty id is a broken
      // config, never a silent clear.
      if (cfg.chat_tag_id !== null && !cfg.chat_tag_id) {
        throw new Error('set_chat_tag needs a chat tag (or null to clear)')
      }
      // A sub-tag id sets it and null clears it; none named (absent or
      // empty) keeps the chat's sub-tag while the main tag is unchanged,
      // so "Set chat tag: Interested" does not drop the chat's bank.
      const written = await writeConversationChatTags(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        next: !cfg.chat_tag_id
          ? { chat_tag_id: null, chat_sub_tag_id: null }
          : cfg.chat_sub_tag_id === null || cfg.chat_sub_tag_id
            ? { chat_tag_id: cfg.chat_tag_id, chat_sub_tag_id: cfg.chat_sub_tag_id }
            : { chat_tag_id: cfg.chat_tag_id },
      })
      if (!written.ok) {
        throw new Error(
          written.reason === 'not_found'
            ? 'set_chat_tag: contact has no conversation'
            : `set_chat_tag failed (${written.reason})${written.message ? `: ${written.message}` : ''}`,
        )
      }
      const { previous, saved } = written
      if (
        previous.chat_tag_id === saved.chat_tag_id &&
        previous.chat_sub_tag_id === saved.chat_sub_tag_id
      ) {
        return 'chat tags unchanged'
      }

      // A chat_tag_set automation that sets a tag can trigger another
      // (or itself, A -> B -> A); the depth travels in the dispatched
      // context and stops the chain. Not chat-tag-dispatch.ts: it
      // imports this module.
      const depth = getChatTagChainDepth(args.context)
      if (depth >= MAX_CHAT_TAG_CHAIN_DEPTH) {
        console.warn('[automations] chat_tag_set chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          chatTagId: saved.chat_tag_id,
          depth,
        })
        return `chat tags set; chat_tag_set dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'chat_tag_set',
        contactId: args.contactId,
        // A tag automation that answers the customer is still an answer to
        // the message this run reacted to.
        salesChat: args.salesChat,
        context: {
          ...(args.context.sales_answers_off
            ? { sales_answers_off: args.context.sales_answers_off }
            : {}),
          conversation_id: written.conversationId,
          chat_tag_id: saved.chat_tag_id,
          chat_sub_tag_id: saved.chat_sub_tag_id,
          previous_chat_tag_id: previous.chat_tag_id,
          previous_chat_sub_tag_id: previous.chat_sub_tag_id,
          vars: { _chat_tag_chain_depth: depth + 1 },
        },
      })
      return 'chat tags set and chat_tag_set dispatched'
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      // Absent = on, so automations saved before the switch keep running.
      if (cfg.enabled === false) return 'assignment step turned off'
      if (cfg.mode === 'round_robin') {
        // The rotation engine (migration 236) decides: the next eligible
        // person of this step's own pool (live, present, under their chat
        // limit), on the contact's company chat. It leaves alone a chat
        // someone holds (inbound gives it to the customer's last caller)
        // or is already working (human_engaged_at). Never throws.
        const { data: chat } = await db
          .from('conversations')
          .select('id')
          .eq('account_id', args.automation.account_id)
          .eq('contact_id', args.contactId)
          .is('personal_owner_id', null)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        const conversationId = (chat as { id?: string } | null)?.id
        if (!conversationId) return 'no chat to assign'
        const result = await rotateAssign(db, {
          accountId: args.automation.account_id,
          conversationId,
          poolKey: automationPoolKey(args.automation.id, step.id),
          candidates: (cfg.people ?? []).filter(
            (p): p is string => typeof p === 'string' && p.length > 0
          ),
        })
        switch (result.reason) {
          case 'assigned':
            return `assigned to ${result.assignedTo}`
          case 'nobody_eligible':
            return 'nobody available to assign'
          case 'error':
            throw new Error(
              `assign_conversation rotation failed: ${result.error ?? 'unknown'}`
            )
          default:
            // already_assigned, engaged, personal, not_found
            return 'no chat to assign'
        }
      }
      const agentId = cfg.agent_id
      if (!agentId) return 'no agent resolved'
      const { data: assigned, error: assignErr } = await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
        .is('personal_owner_id', null)
        .select('id')
      failOnWriteError(assignErr, 'assign_conversation: the chat could not be assigned')
      return assigned?.length ? `assigned to ${agentId}` : 'no chat to assign'
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field, error: fieldErr } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        failOnWriteError(fieldErr, 'update_contact_field: the custom field could not be read')
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        const { error: valueErr } = await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        failOnWriteError(valueErr, 'update_contact_field: the contact could not be saved')
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      const { error: contactErr } = await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      failOnWriteError(contactErr, 'update_contact_field: the contact could not be saved')
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      // Own the deal the way a tagged chat's deal is owned (migration
      // 080), or the chat's agent cannot see it. Without an owner
      // (pre-080 database, no conversation) it stays the automation's.
      const owner = await resolveAutomationDealOwner(args)
      const { error: dealErr } = await db.from('deals').insert({
        // Tenancy is the automation's account; user_id is the deal's
        // owner (resolved above), else the automation's author.
        account_id: args.automation.account_id,
        user_id: owner?.userId ?? args.automation.user_id,
        ...(owner ? { assigned_to: owner.profileId } : {}),
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      failOnWriteError(dealErr, 'create_deal: the deal could not be saved')
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts):
      // this early check, then safeFetch re-vets the connected address so
      // a DNS answer that flips in between (rebinding) is refused too.
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await safeFetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      // The body is never read; release the socket now.
      void res.body?.cancel().catch(() => {})
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      const { error: closeErr } = await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
        .is('personal_owner_id', null)
      failOnWriteError(closeErr, 'close_conversation: the chat could not be closed')
      return 'conversation closed'
    }

    case 'post_team_chat': {
      const cfg = step.step_config as PostTeamChatStepConfig
      if (!cfg.channel_id) throw new Error('post_team_chat needs a channel')
      // Filled-in values (customer text, vars) cannot bold or mention.
      const body = clipTeamChatBody(interpolate(cfg.text ?? '', args, neutraliseTeamChatValue))
      if (!body) throw new Error('post_team_chat has empty text')
      // chat_post_system_message trusts its caller (service role only)
      // and the service role bypasses RLS, so the stored channel id is
      // confined here: this automation's account, a team or private
      // channel, every run.
      const { data: channel, error: channelErr } = await db
        .from('chat_channels')
        .select('id, kind, archived_at')
        .eq('id', cfg.channel_id)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      if (channelErr) {
        throw new Error(`post_team_chat: channel lookup failed: ${channelErr.message}`)
      }
      const refusal = teamChatChannelRefusal(
        channel as { kind: string; archived_at: string | null } | null,
      )
      if (refusal) throw new Error(refusal)
      // A bank guest reads the channel's messages and the body can carry
      // customer text: refused on every run, so a guest added after the
      // automation was saved stops it (087's card test, migration 102).
      const { data: guests, error: guestErr } = await db.rpc('chat_channels_with_guests', {
        p_channels: [cfg.channel_id],
      })
      if (guestErr) {
        throw new Error(`post_team_chat: bank guest check failed: ${guestErr.message}`)
      }
      const guestRefusal = teamChatGuestRefusal(guests)
      if (guestRefusal) throw new Error(guestRefusal)
      // The trail back to the customer whose words the post may copy,
      // for an audit or an erasure request; a verified id, never the
      // context's as given.
      const conversationId = args.contactId
        ? await resolveConversationId(args).catch(() => null)
        : null
      const { data: messageId, error: postErr } = await db.rpc('chat_post_system_message', {
        p_channel: cfg.channel_id,
        p_body: body,
        p_meta: {
          source: 'automation',
          automation_id: args.automation.id,
          conversation_id: conversationId,
          contact_id: args.contactId,
        },
      })
      if (postErr) throw new Error(describeTeamChatPostError(postErr))
      return `posted to team chat (${String(messageId ?? '')})`
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Contact-tag steps and the condition subject that read contact tags,
 *  retired with contact tags; stored automations may still carry them. */
const RETIRED_STEP_TYPES: ReadonlySet<string> = new Set(['add_tag', 'remove_tag'])
const RETIRED_CONDITION_SUBJECTS: ReadonlySet<string> = new Set(['tag_presence'])

/** Every step that sends the customer a message. A new one joins this
 *  list, or it messages customers who opted out. */
const MESSAGE_STEP_TYPES: ReadonlySet<string> = new Set([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
])

/** The log's `error_message` when a parked wait is not resumed. */
const STOPPED_SWITCHED_OFF = 'stopped: the automation was switched off'
const STOPPED_INTERRUPTED = 'stopped: interrupted'
const STOPPED_CHANGED = 'stopped: automation changed while waiting'

/** The log detail of a message step the consent register refused. */
const SKIPPED_OPTED_OUT = 'skipped: the customer opted out'
const SKIPPED_DO_NOT_CONTACT = 'skipped: the customer is marked do not contact'

/** Why this run's chat is not a sales chat, or null. */
async function notSalesReason(args: ExecuteArgs): Promise<string | null> {
  return args.context.sales_answers_off || (await salesAnswersOff(args.salesChat))
}

/** Why a message step stays off in a chat that is not a sales chat, or null. */
async function notSalesSkipReason(
  step: AutomationStep,
  args: ExecuteArgs,
): Promise<string | null> {
  if (!MESSAGE_STEP_TYPES.has(step.step_type)) return null
  const reason = await notSalesReason(args)
  return reason ? `skipped: ${reason}` : null
}

/**
 * Why a message step must not run, or null to run it. A do-not-contact
 * customer is sent nothing, also right after they wrote (as in Flows). A
 * contact with `opted_out_at` gets a message only as a direct answer to
 * what they just wrote. A flag that cannot be read stops the message.
 */
async function optOutSkipReason(
  step: AutomationStep,
  args: ExecuteArgs,
): Promise<string | null> {
  if (!MESSAGE_STEP_TYPES.has(step.step_type)) return null
  // The step itself fails on a missing contact.
  if (!args.contactId) return null
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('opted_out_at, do_not_contact_at')
    .eq('id', args.contactId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle()
  if (error) {
    console.error('[automations] opt-out read failed, not sending:', args.automation.id, error)
    return 'skipped: could not check whether the customer opted out'
  }
  // What the sender itself says of a contact it cannot find.
  if (!data) throw new Error('contact not found for this account')
  const refusal = consentRefusal(
    data as { opted_out_at?: string | null; do_not_contact_at?: string | null },
  )
  if (refusal === 'do_not_contact') return SKIPPED_DO_NOT_CONTACT
  return refusal && !args.customerJustWrote ? SKIPPED_OPTED_OUT : null
}

/** Fails the step with a short reason; the database's own text only goes
 *  to the server log. */
function failOnWriteError(error: unknown, reason: string): void {
  if (!error) return
  console.error(`[automations] ${reason}:`, error)
  throw new Error(reason)
}

/** How many chat_tag_set dispatches deep a run may be and still dispatch. */
export const MAX_CHAT_TAG_CHAIN_DEPTH = 3

/** `vars._chat_tag_chain_depth`; absent or malformed is 0. */
function getChatTagChainDepth(context: AutomationContext): number {
  const raw = context.vars?._chat_tag_chain_depth
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0
}

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 *
 * `context.conversation_id` is NOT trusted as-is: the manual engine
 * route passes the request body's `context` straight through, and the
 * send path writes `messages` / `conversations` on the service-role
 * client keyed only on this id. An unchecked id is a cross-tenant
 * write, so it is used only after it is confirmed to belong to this
 * account AND this contact; otherwise we fall back to the lookup below.
 */
/**
 * The owner of a deal an automation opens for the contact's chat: the
 * same rule as a deal opened by tagging the chat
 * (`resolve_chat_deal_owner`, migration 080, with no acting person),
 * as an auth user id plus the profile id `deals.assigned_to` stores.
 * Fail-soft: `null` on any miss, and the caller keeps the old owner.
 */
async function resolveAutomationDealOwner(
  args: ExecuteArgs
): Promise<{ userId: string; profileId: string } | null> {
  try {
    const conversationId = await resolveConversationId(args)
    const db = supabaseAdmin()
    const { data: owner, error } = await db.rpc('resolve_chat_deal_owner', {
      p_conversation_id: conversationId,
      p_actor: null,
    })
    if (error || typeof owner !== 'string' || !owner) return null
    const { data: profile } = await db
      .from('profiles')
      .select('id')
      .eq('user_id', owner)
      .eq('account_id', args.automation.account_id)
      .maybeSingle()
    if (!profile?.id) return null
    return { userId: owner, profileId: profile.id as string }
  } catch {
    return null
  }
}

export async function resolveConversationId(
  args: Pick<ExecuteArgs, 'automation' | 'contactId' | 'context' | 'triggerEvent'>
): Promise<string> {
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const fromCtx = args.context.conversation_id
  if (typeof fromCtx === 'string' && fromCtx) {
    const { data: owned } = await supabaseAdmin()
      .from('conversations')
      .select('id')
      .eq('id', fromCtx)
      .eq('account_id', args.automation.account_id)
      .eq('contact_id', args.contactId)
      .maybeSingle()
    if (owned?.id) return owned.id as string
    console.warn(
      '[automations] ignoring context.conversation_id not owned by this account/contact',
      fromCtx
    )
  }
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .is('personal_owner_id', null)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) {
    throw new Error('cannot send: contact has no existing conversation')
  }
  return data.id as string
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

/**
 * intent_match: which of these automations the inbound text means
 * (p per key `automation:<id>`, each at or above its own threshold).
 * Shares the per-message memo and the account's candidate set with the
 * Flows engine, so one Jev request covers both. Needs the text and the gateway message id; empty otherwise.
 */
async function judgeIntentAutomations(
  input: DispatchInput,
  automations: Automation[],
): Promise<Map<string, number>> {
  const text = (input.context?.message_text ?? '').toString()
  const messageKey = input.context?.message_id
  const conversationId = input.context?.conversation_id
  if (!text.trim() || !messageKey) return new Map()
  return judgeMeanings({
    accountId: input.accountId,
    messageKey,
    text,
    recentTurns: conversationId ? () => loadMeaningTurns(conversationId, text) : [],
    // An invalid stored config is skipped, never sent to Jev.
    candidates: automations.flatMap((a) => {
      const c = meaningCandidate(`automation:${a.id}`, a.trigger_config, a.updated_at)
      return c ? [c] : []
    }),
  })
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  // Fires when the chat ARRIVES at the configured tag, not while it
  // merely carries it.
  if (automation.trigger_type === 'chat_tag_set') {
    const cfg = automation.trigger_config as ChatTagTriggerConfig
    if (!cfg?.chat_tag_id) return false
    return chatTagTriggerMatches(cfg, {
      previous: {
        chat_tag_id: ctx?.previous_chat_tag_id ?? null,
        chat_sub_tag_id: ctx?.previous_chat_sub_tag_id ?? null,
      },
      current: {
        chat_tag_id: ctx?.chat_tag_id ?? null,
        chat_sub_tag_id: ctx?.chat_sub_tag_id ?? null,
      },
    })
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  if (RETIRED_CONDITION_SUBJECTS.has(cfg.subject)) {
    console.warn('[automations] retired condition subject evaluates false', {
      automationId: args.automation.id,
      subject: cfg.subject,
    })
    return false
  }
  switch (cfg.subject) {
    case 'chat_tag_presence': {
      // `operand` holds the tag id, as for every other subject. True when
      // it is the chat's main tag or its sub-tag.
      if (!args.contactId || !cfg.operand) return false
      const { data, error } = await db
        .from('conversations')
        .select('chat_tag_id, chat_sub_tag_id')
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
        .is('personal_owner_id', null)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`chat tag lookup failed: ${error.message}`)
      const row = data as { chat_tag_id: string | null; chat_sub_tag_id: string | null } | null
      return row?.chat_tag_id === cfg.operand || row?.chat_sub_tag_id === cfg.operand
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // The wall clock of AUTOMATION_TIME_ZONE, never the server's (UTC
      // in production).
      return isInTimeRange(cfg.operand, new Date())
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

/** `{{ message.text }}` / `{{ vars.x }}`; `escape` applies to each filled-in value. */
function interpolate(
  s: string,
  args: ExecuteArgs,
  escape: (value: string) => string = (value) => value,
): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return escape(String(args.context.message_text ?? ''))
    if (ns === 'vars' && prop) return escape(String(args.context.vars?.[prop] ?? ''))
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged, status }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}

const MAX_RELEASES = 5

/**
 * A read failed before the run took a step: put the claimed row back for
 * the next tick, at most MAX_RELEASES times. Only a row still `running`,
 * so one the sweep below has settled stays settled.
 */
async function releasePending(
  pending: { id: string; automation_id: string; log_id: string | null; attempts?: number | null },
  what: string,
  error: unknown,
): Promise<void> {
  console.error(`[automations] resume: ${what} load failed`, pending.automation_id, error)
  const attempts = pending.attempts ?? 0
  if (attempts >= MAX_RELEASES) {
    await finalizeLog(pending.log_id, 'failed', `stopped: the ${what} could not be loaded`)
    await markPending(pending.id, 'failed')
    return
  }
  const { error: releaseErr } = await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status: 'pending', attempts: attempts + 1, claimed_at: null })
    .eq('id', pending.id)
    .eq('status', 'running')
  // Left `running`: the sweep fails it. Never a second run.
  if (releaseErr) console.error('[automations] release failed:', pending.id, releaseErr)
}

const INTERRUPTED_AFTER_MS = 30 * 60_000

/**
 * Runs a restart cut off: claimed more than 30 minutes ago and never
 * settled. They may have sent already, so they end as failed and are
 * never run again. A row the build before 269 claimed has no
 * `claimed_at`; its due time stands in.
 */
export async function failInterruptedExecutions(now = Date.now()): Promise<number> {
  const db = supabaseAdmin()
  const cutoff = new Date(now - INTERRUPTED_AFTER_MS).toISOString()
  const fail = () =>
    db
      .from('automation_pending_executions')
      .update({ status: 'failed' })
      .eq('status', 'running')
  const settled = [
    await fail().lt('claimed_at', cutoff).select('id, automation_id, log_id'),
    await fail().is('claimed_at', null).lt('run_at', cutoff).select('id, automation_id, log_id'),
  ]
  let count = 0
  for (const { data, error } of settled) {
    if (error) console.error('[automations] interrupted sweep failed:', error)
    for (const row of data ?? []) {
      count++
      console.error('[automations] run interrupted, not run again', row.automation_id, row.id)
      if (!row.log_id) continue
      // Only a log still waiting: a run that finished but could not mark
      // its row keeps its own result.
      const { error: logErr } = await db
        .from('automation_logs')
        .update({ status: 'failed', error_message: STOPPED_INTERRUPTED })
        .eq('id', row.log_id)
        .eq('status', 'partial')
      if (logErr) console.error('[automations] interrupted log update failed:', logErr)
    }
  }
  return count
}
