// ============================================================
// POST /api/assist/chat/[conversationId] — the inbox's Assistant panel
// (migration 321, docs/ai-agent.md).
//
// Body: { task: 'summary' | 'draft' | 'ask' | 'suggest', question?, locale? }
//   summary  → { text }   who, what they want, what is pending, last promise
//   draft    → { draft }  a reply for the composer; never sent from here
//   ask      → { text }   a question about the chat, answered from it
//   suggest  → { cards }  actions held for the person's confirmation
//
// Off until an owner or admin switches it on (inbox_assistant_settings);
// agents and up. The chat is read through 019a's guarded router as a
// READ tool on the caller's own client, so only what they can see goes
// in, capped at the last 60 messages. Suggested actions go through the
// same router as WRITE tools in the supervised mode: each is recorded
// as a pending action (assist_pending_request) and NOTHING runs until
// the person confirms it (POST /api/assist/pending/[id]) and the panel
// runs it (POST …/run). The model call uses the workspace's own AI key
// (loadAiConfig → generateReply → callProvider, which masks and calls
// assertAiTransfer) and its spend is logged as mode 'chat_assist'.
// ============================================================

import { NextResponse, after } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadCampaignContext } from '@/lib/ai/auto-reply';
import { loadAiConfig } from '@/lib/ai/config';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import {
  buildDraftMessages,
  unansweredCustomerText,
  type DraftMessageRow,
} from '@/lib/ai/draft-prompt';
import { generateReply } from '@/lib/ai/generate';
import { retrieveKnowledge } from '@/lib/ai/knowledge';
import { AiError, type AiConfig, type ChatMessage } from '@/lib/ai/types';
import { logAiUsage, logFailedAiUsage } from '@/lib/ai/usage';
import { planActions, currentTagOrdinal } from '@/lib/chat-assist/actions';
import { chatAssistGate, chatAssistRefusalBody } from '@/lib/chat-assist/gate';
import { chatAssistHandlers } from '@/lib/chat-assist/handlers';
import {
  buildAskPrompt,
  buildSuggestPrompt,
  buildSummaryPrompt,
  normalizeQuestion,
} from '@/lib/chat-assist/prompt';
import { loadSuggestRefs } from '@/lib/chat-assist/refs';
import {
  chatAssistContext,
  createChatAssistRouter,
  holdActions,
} from '@/lib/chat-assist/router';
import { readChatAssistEnabled } from '@/lib/chat-assist/settings';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';

// A model call plus a few guarded RPCs.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASKS = ['summary', 'draft', 'ask', 'suggest'] as const;
type Task = (typeof TASKS)[number];

type Params = { params: Promise<{ conversationId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();
    const { conversationId } = await params;
    if (!UUID.test(conversationId))
      return NextResponse.json({ error: 'Invalid chat id' }, { status: 400 });

    // The role and the workspace switch, before anything else is read.
    const gate = chatAssistGate({
      role,
      enabled: await readChatAssistEnabled(supabase, accountId),
    });
    if (!gate.ok)
      return NextResponse.json(chatAssistRefusalBody(gate.reason), {
        status: 403,
      });

    const body = (await request.json().catch(() => null)) as {
      task?: unknown;
      question?: unknown;
      locale?: unknown;
    } | null;
    const task = body?.task;
    if (!(TASKS as readonly unknown[]).includes(task))
      return NextResponse.json(
        { error: `task must be one of ${TASKS.join(', ')}` },
        { status: 400 }
      );
    const question = normalizeQuestion(body?.question);
    if (task === 'ask' && !question)
      return NextResponse.json(
        { error: 'A question is required' },
        { status: 400 }
      );
    const locale = isLocale(body?.locale) ? body.locale : DEFAULT_LOCALE;

    // The same budget as the composer's AI draft, kept apart from it.
    const userLimit = checkRateLimit(
      `chat-assist:${userId}`,
      RATE_LIMITS.aiDraft
    );
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(
      `chat-assist-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    // RLS: a chat the caller cannot see is simply not found.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select(
        'id, assigned_agent_id, chat_tag_id, chat_sub_tag_id, campaign_broadcast_id, contact:contacts(name)'
      )
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) {
      console.error('[assist/chat] conversation lookup failed:', convErr.code);
      return NextResponse.json(
        { error: 'Failed to load the chat' },
        { status: 500 }
      );
    }
    if (!conversation)
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    const conv = conversation as {
      assigned_agent_id: string | null;
      chat_tag_id: string | null;
      chat_sub_tag_id: string | null;
      campaign_broadcast_id: string | null;
      contact?: unknown;
    };
    const embed = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
    const contactName =
      typeof (embed as { name?: unknown } | null)?.name === 'string'
        ? ((embed as { name: string }).name as string)
        : null;

    // ai_configs holds the encrypted key: admin-only under RLS, so the
    // service role reads it, scoped to the caller's account.
    const config = await loadAiConfig(supabaseAdmin(), accountId).catch(() => {
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config)
      return NextResponse.json(
        {
          error: 'AI is not set up. Enable it in AI Agents → Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );

    const admin = supabaseAdmin();
    const assist = createChatAssistRouter(
      admin,
      chatAssistHandlers({
        rls: supabase,
        accountId,
        userId,
        conversationId,
        defer: (fn) => after(fn),
      })
    );
    const ctx = chatAssistContext({ userId, accountId });

    // The chat, as a READ tool through the guard (rate-limited, audited).
    const read = await assist.router.execute(ctx, {
      tool: 'chat_read',
      args: { conversationId },
    });
    if (read.status !== 'ok') {
      const reason = read.status === 'denied' ? read.reason : 'READ_FAILED';
      return NextResponse.json(
        { error: 'The assistant could not read the chat now.', code: reason },
        { status: reason === 'RATE_LIMITED' ? 429 : 503 }
      );
    }
    const rows = read.result as DraftMessageRow[];

    const generate = async (systemPrompt: string, messages: ChatMessage[]) =>
      runModel(config, systemPrompt, messages, accountId, conversationId);

    switch (task as Task) {
      case 'summary': {
        const p = buildSummaryPrompt({ rows, contactName, locale });
        return NextResponse.json({
          text: await generate(p.systemPrompt, p.messages),
        });
      }
      case 'ask': {
        const p = buildAskPrompt({ rows, contactName, question, locale });
        return NextResponse.json({
          text: await generate(p.systemPrompt, p.messages),
        });
      }
      case 'draft': {
        // The composer's own draft prompt: the chat's language, the
        // knowledge base and the campaign the customer is answering.
        const messages = buildDraftMessages({ rows, contactName });
        if (!messages)
          return NextResponse.json(
            { error: 'No messages to draft from yet.', code: 'no_messages' },
            { status: 400 }
          );
        const query = unansweredCustomerText(rows);
        const knowledge = query
          ? await retrieveKnowledge(supabase, accountId, config, query)
          : [];
        const campaign = conv.campaign_broadcast_id
          ? await loadCampaignContext(
              admin,
              accountId,
              conv.campaign_broadcast_id
            )
          : null;
        const systemPrompt = buildSystemPrompt({
          userPrompt: config.systemPrompt,
          mode: 'draft',
          knowledge,
          campaign,
        });
        return NextResponse.json({
          draft: await generate(systemPrompt, messages),
        });
      }
      case 'suggest': {
        const refs = await loadSuggestRefs(supabase, {
          accountId,
          userId,
          role,
        });
        const p = buildSuggestPrompt({
          rows,
          contactName,
          tags: refs.tags,
          members: refs.members,
          currentTag: currentTagOrdinal(
            refs.tags,
            conv.chat_tag_id,
            conv.chat_sub_tag_id
          ),
          locale,
        });
        const text = await generate(p.systemPrompt, p.messages);
        const planned = planActions(text, {
          conversationId,
          tags: refs.tags,
          members: refs.members,
          currentTagId: conv.chat_tag_id,
          currentSubTagId: conv.chat_sub_tag_id,
          assignedTo: conv.assigned_agent_id,
          now: Date.now(),
        });
        // Each one is held for the person; nothing runs here.
        const cards = await holdActions(assist, ctx, planned);
        return NextResponse.json({ cards });
      }
    }
  } catch (err) {
    if (err instanceof AiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    return toErrorResponse(err);
  }
}

/** One model call on the workspace's key, its spend logged as 'chat_assist'. */
async function runModel(
  config: AiConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  accountId: string,
  conversationId: string
): Promise<string> {
  const usageArgs = {
    accountId,
    conversationId,
    mode: 'chat_assist' as const,
    provider: config.provider,
    model: config.model,
  };
  const { text, usage } = await generateReply({
    config,
    systemPrompt,
    messages,
    purpose: 'chat_assist',
  }).catch(async (err) => {
    await logFailedAiUsage(supabaseAdmin, err, usageArgs);
    throw err;
  });
  try {
    void logAiUsage(supabaseAdmin(), { ...usageArgs, usage });
  } catch (logErr) {
    console.error('[assist/chat] usage log skipped:', logErr);
  }
  return text;
}
