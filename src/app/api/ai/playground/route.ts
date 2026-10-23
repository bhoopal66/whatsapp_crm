import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { retrieveKnowledgeScored } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { matchEscalationKeyword } from '@/lib/ai/escalation'
import { retrievalGateFailure } from '@/lib/ai/auto-reply'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — escalation keywords,
 * retrieval threshold, knowledge-base retrieval + `auto_reply` system
 * prompt + the configured provider — so what you see here is what a
 * real customer would get. A gate handoff comes back as the configured
 * handoff message (or empty) with `handoff_reason` set; nothing is
 * logged to the knowledge gaps from here. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 *
 * Not simulated here: the TypeSafe decision layer (migration 063 —
 * triage, the passage filter, the guardrail). Playground text is not
 * sent to TypeSafe or written to its log, so with a check acting, a real
 * customer can be handed off or have a draft held where this preview
 * answered. docs/typesafe.md says how to watch those decisions in shadow.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)
    // The playground spends the same shared BYO key as drafts, so it
    // draws on the same team-wide cap; a per-person limit alone let N
    // people spend N times it.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    // Service-role read, scoped by the account requireRole resolved:
    // ai_configs holds the encrypted provider key, so its RLS is
    // admin-only (migration 057) and an agent's own client sees no row.
    const config = await loadAiConfig(supabaseAdmin(), accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const question = latestUserMessage(messages)

    // Gate 1 — escalation keywords.
    const keyword = matchEscalationKeyword(question, config.escalationKeywords)
    if (keyword) {
      return NextResponse.json({
        reply: config.handoffMessage ?? '',
        handoff: true,
        handoff_reason: 'keyword',
        handoff_detail: keyword,
      })
    }

    const retrieval = await retrieveKnowledgeScored(
      supabase,
      accountId,
      config,
      question,
    )

    // Gate 2 — retrieval threshold.
    const gap = retrievalGateFailure(retrieval, config.retrievalMinScore, question)
    if (gap) {
      return NextResponse.json({
        reply: config.handoffMessage ?? '',
        handoff: true,
        handoff_reason: 'no_knowledge',
        handoff_detail: gap.detail,
      })
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge: retrieval.excerpts,
      strictGrounding: config.strictGrounding,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    // Recorded as a draft (ai_usage_log's mode CHECK knows only
    // auto_reply and draft): playground tokens are real spend on the
    // account's key and used to be invisible in the usage log.
    void logAiUsage(supabaseAdmin(), {
      accountId,
      conversationId: null,
      mode: 'draft',
      provider: config.provider,
      model: config.model,
      usage,
    })
    return NextResponse.json({
      reply: text,
      handoff,
      handoff_reason: handoff ? 'model' : null,
    })
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
