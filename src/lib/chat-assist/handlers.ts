/**
 * The handlers behind the panel's tools. Every one runs on the CALLER's
 * own client (RLS), through the path the rest of the app already uses
 * for the same change, so the assistant never widens what a person may
 * do:
 *
 *   chat_read         messages of the chat, as the caller sees them
 *   chat_set_tag      writeConversationChatTags (compare-and-set), then
 *                     clearTagSuggestion and chat_tag_set automations in
 *                     after(), as PUT /api/conversations/[id]/chat-tags
 *   chat_create_task  parseCreateTaskBody + the tasks insert, as
 *                     POST /api/tasks (kind follow_up, source chat, the
 *                     caller's own task)
 *   chat_assign       assignConversation, the inbox's assign write
 *   chat_add_note     an insert into 241's conversation_notes (never
 *                     messages): written here, never read into a prompt
 *   brain_search      searchBrain as the caller (`scope.brain`), within
 *                     the /brain search route's 60-a-minute bucket
 *   brain_remember    the /brain "remember this" path (redacted), tied
 *                     to the chat's contact
 *
 * The brain handlers re-check `chatAssistBrainCheck` (access, switch,
 * AI transfer) every time: a card confirmed while the brain was on must
 * not run once it is off. Without `scope.brain` they refuse.
 *
 * A handler runs only when the router's guard allowed it: a READ
 * directly, a WRITE only after the person's confirmation was consumed.
 * Each re-checks its arguments and that they name the chat of the
 * request, and throws on any refusal (the router audits the error).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ToolHandler } from '@/lib/assist/router';
import type { DraftMessageRow } from '@/lib/ai/draft-prompt';
import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { clearTagSuggestion } from '@/lib/chat-tags/clear-suggestion';
import { writeConversationChatTags } from '@/lib/chat-tags/server';
import { assignConversation } from '@/lib/inbox/assign';
import { parseCreateTaskBody } from '@/lib/tasks/requests';

import { chatAssistBrainCheck, type ChatAssistBrainPort } from './brain';
import {
  CHAT_ASSIST_MESSAGE_CAP,
  CHAT_ASSIST_MESSAGE_COLUMNS,
  capChatContext,
} from './context';
import { parseToolArgs, type ChatAssistTool } from './tools';

/** A refusal the panel words; the message is ours, never the database's. */
export class ChatAssistActionError extends Error {
  constructor(
    readonly code:
      'bad_args' | 'not_found' | 'refused' | 'changed' | 'invalid' | 'failed'
  ) {
    super(code);
    this.name = 'ChatAssistActionError';
  }
}

export interface HandlerScope {
  /** The caller's own RLS client. */
  rls: SupabaseClient;
  accountId: string;
  userId: string;
  /** The chat of the request: every call must name it. */
  conversationId: string;
  /** Work after the response (Next's `after`); tests pass a stub. */
  defer: (fn: () => Promise<void>) => void;
  /** The second brain, as the caller (`brain-server.ts`); absent: refused. */
  brain?: ChatAssistBrainPort;
}

function argsFor<T extends ChatAssistTool>(
  tool: T,
  raw: unknown,
  scope: HandlerScope
) {
  const args = parseToolArgs(tool, raw);
  if (!args || args.conversationId !== scope.conversationId)
    throw new ChatAssistActionError('bad_args');
  return args;
}

export function chatAssistHandlers(
  scope: HandlerScope
): Record<ChatAssistTool, ToolHandler> {
  const { rls } = scope;
  return {
    chat_read: async (raw) => {
      const args = argsFor('chat_read', raw, scope);
      const { data, error } = await rls
        .from('messages')
        .select(CHAT_ASSIST_MESSAGE_COLUMNS)
        .eq('conversation_id', args.conversationId)
        .order('created_at', { ascending: false })
        .limit(CHAT_ASSIST_MESSAGE_CAP);
      if (error) throw new ChatAssistActionError('failed');
      return capChatContext((data ?? []) as DraftMessageRow[]);
    },

    chat_set_tag: async (raw) => {
      const args = argsFor('chat_set_tag', raw, scope);
      const result = await writeConversationChatTags(rls, {
        accountId: scope.accountId,
        conversationId: args.conversationId,
        next: { chat_tag_id: args.tagId, chat_sub_tag_id: args.subTagId },
      });
      if (!result.ok)
        throw new ChatAssistActionError(
          result.reason === 'not_found'
            ? 'not_found'
            : result.reason === 'invalid'
              ? 'invalid'
              : 'failed'
        );
      const { previous, saved } = result;
      if (
        previous.chat_tag_id !== saved.chat_tag_id ||
        previous.chat_sub_tag_id !== saved.chat_sub_tag_id
      ) {
        await clearTagSuggestion(scope.accountId, result.conversationId);
        scope.defer(() =>
          dispatchChatTagSet({
            accountId: scope.accountId,
            contactId: result.contactId,
            conversationId: result.conversationId,
            previous,
            saved,
          })
        );
      }
      return {
        chat_tag_id: saved.chat_tag_id,
        chat_sub_tag_id: saved.chat_sub_tag_id,
      };
    },

    chat_create_task: async (raw) => {
      const args = argsFor('chat_create_task', raw, scope);
      const parsed = parseCreateTaskBody(
        {
          title: args.title,
          kind: 'follow_up',
          source: 'chat',
          conversationId: args.conversationId,
          dueAt: args.dueAt,
        },
        scope.userId
      );
      if (!parsed.ok) throw new ChatAssistActionError('bad_args');
      const { data: conversation, error: convErr } = await rls
        .from('conversations')
        .select('contact_id')
        .eq('account_id', scope.accountId)
        .eq('id', args.conversationId)
        .maybeSingle();
      if (convErr) throw new ChatAssistActionError('failed');
      if (!conversation) throw new ChatAssistActionError('not_found');
      const { data, error } = await rls
        .from('tasks')
        .insert({
          ...parsed.values,
          contact_id: (conversation as { contact_id: string | null })
            .contact_id,
          account_id: scope.accountId,
          created_by: scope.userId,
        })
        .select('id')
        .single();
      if (error || !data)
        throw new ChatAssistActionError(
          error?.code === '42501' ? 'refused' : 'failed'
        );
      return { taskId: (data as { id: string }).id };
    },

    chat_assign: async (raw) => {
      const args = argsFor('chat_assign', raw, scope);
      const result = await assignConversation(
        rls,
        args.conversationId,
        args.expected,
        args.userId
      );
      if (result.ok) return { assignedTo: result.assignedAgentId };
      throw new ChatAssistActionError(
        result.reason === 'moved'
          ? 'not_found'
          : result.reason === 'changed'
            ? 'changed'
            : result.reason === 'refused'
              ? 'refused'
              : 'failed'
      );
    },

    chat_add_note: async (raw) => {
      const args = argsFor('chat_add_note', raw, scope);
      const { data, error } = await rls
        .from('conversation_notes')
        .insert({
          conversation_id: args.conversationId,
          body: args.body,
          mention_ids: [],
        })
        .select('id')
        .single();
      if (error || !data)
        throw new ChatAssistActionError(
          error?.code === '42501' ? 'refused' : 'failed'
        );
      return { noteId: (data as { id: string }).id };
    },

    brain_search: async (raw) => {
      const args = argsFor('brain_search', raw, scope);
      const check = await chatAssistBrainCheck(
        scope.brain,
        'brain_search',
        args.query.length
      );
      if (!check.ok || !scope.brain) throw new ChatAssistActionError('refused');
      if (!(await scope.brain.searchAllowed()))
        throw new ChatAssistActionError('refused');
      return scope.brain.search(args.query);
    },

    brain_remember: async (raw) => {
      const args = argsFor('brain_remember', raw, scope);
      const check = await chatAssistBrainCheck(
        scope.brain,
        'brain_remember',
        args.text.length
      );
      if (!check.ok || !scope.brain) throw new ChatAssistActionError('refused');
      // The chat must still be the caller's to see; its contact is the
      // note's (RLS read, as the task handler does).
      const { data: conversation, error: convErr } = await rls
        .from('conversations')
        .select('contact_id')
        .eq('account_id', scope.accountId)
        .eq('id', args.conversationId)
        .maybeSingle();
      if (convErr) throw new ChatAssistActionError('failed');
      if (!conversation) throw new ChatAssistActionError('not_found');
      const r = await scope.brain.remember(
        args.text,
        (conversation as { contact_id: string | null }).contact_id
      );
      // The redactor refused the text: nothing was stored.
      if (!r.ok) throw new ChatAssistActionError('invalid');
      return { itemIds: r.itemIds };
    },
  };
}
