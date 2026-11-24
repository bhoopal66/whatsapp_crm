import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { aiContextMessageLimit } from '@/lib/ai/defaults'
import {
  buildDraftMessages,
  normalizeTyped,
  unansweredCustomerText,
  type DraftMessageRow,
} from '@/lib/ai/draft-prompt'
import { loadCampaignContext } from '@/lib/ai/auto-reply'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { logAiUsage, logFailedAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/draft  (agent+)
 *
 * Body: { conversation_id, typed? }
 * Returns: { draft } — a suggested reply for the agent to edit + send.
 *
 * The last messages go to the model as one transcript with the task
 * spelled out (lib/ai/draft-prompt.ts), plus the campaign the customer
 * is answering. `typed` is what the agent has in the reply box: the
 * draft then says that, fitted to the conversation.
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const typed = normalizeTyped(body?.typed)
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, campaign_broadcast_id, contact:contacts(name)')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/draft] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    // Service-role read, scoped by the account requireRole resolved:
    // ai_configs holds the encrypted provider key, so its RLS is
    // admin-only (migration 057) and an agent's own client sees no row.
    const config = await loadAiConfig(supabaseAdmin(), accountId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      console.error('[ai/draft] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in AI Agents → Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // The caller's own client: RLS shows them only a thread they can see
    // (the lookup above already proved they can).
    const { data: rowData, error: rowsErr } = await supabase
      .from('messages')
      .select('sender_type, content_type, content_text, created_at, status')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(aiContextMessageLimit())
    if (rowsErr) {
      console.error('[ai/draft] messages lookup error:', rowsErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    const rows = (rowData ?? []) as DraftMessageRow[]

    // PostgREST may hand a to-one embed back as an object or a one-row array.
    const embed = (conversation as { contact?: unknown }).contact
    const contact = (Array.isArray(embed) ? embed[0] : embed) as
      | { name?: unknown }
      | null
      | undefined
    const contactName = typeof contact?.name === 'string' ? contact.name : null

    const messages = buildDraftMessages({ rows, typed, contactName })
    // Nothing to draft from — a brand-new thread with nothing typed
    // would otherwise produce a nonsensical reply-to-nothing.
    if (!messages) {
      return NextResponse.json(
        {
          error: 'No messages to draft from yet.',
          code: 'no_messages',
        },
        { status: 400 },
      )
    }

    // Ground the draft in the account's knowledge base (best-effort —
    // returns [] when there's no KB or retrieval fails).
    // Retrieve for what the reply is about: the customer's unanswered
    // messages and what the agent typed.
    const query = [unansweredCustomerText(rows), typed]
      .filter(Boolean)
      .join('\n')
    const knowledge = query
      ? await retrieveKnowledge(supabase, accountId, config, query)
      : []

    // The campaign template never lands in the thread (migration 048),
    // so without it a reply to a campaign has nothing to answer.
    // Service role, scoped to the account: broadcasts are admin-read.
    const broadcastId = (conversation as { campaign_broadcast_id?: string | null })
      .campaign_broadcast_id
    const campaign = broadcastId
      ? await loadCampaignContext(supabaseAdmin(), accountId, broadcastId)
      : null

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
      campaign,
    })

    const { text, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
      purpose: 'draft',
    }).catch(async (err) => {
      // Billed even when the answer was cut off or empty.
      await logFailedAiUsage(supabaseAdmin, err, {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
      })
      throw err
    })

    // Record spend on the account's BYO key. Best-effort + via the
    // service role (the log has no `authenticated` INSERT policy). This
    // must not fail or delay the draft the agent is waiting on, so:
    //  - the whole thing is wrapped (constructing the admin client throws
    //    if the service-role key is unset — that must not 500 the draft);
    //  - it's fire-and-forget (`void`), not awaited, so the response
    //    isn't held for a DB round-trip.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/draft] usage log skipped:', logErr)
    }

    return NextResponse.json({ draft: text })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
