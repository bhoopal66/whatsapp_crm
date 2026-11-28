/**
 * The in-chat assistant's tools, as registered with 019a's assistant
 * safety layer (`lib/assist/*`, migration 120).
 *
 *   chat_read          READ   the chat's recent messages, as the caller
 *   chat_set_tag       WRITE  main tag (+ sub-tag) via writeConversationChatTags
 *   chat_create_task   WRITE  a follow-up task, the person's own (source chat)
 *   chat_assign        WRITE  the inbox's assign write (assignConversation)
 *   chat_add_note      WRITE  an internal note (conversation_notes, 241)
 *
 * No DANGEROUS tool exists here, and nothing that sends to a customer.
 * The panel runs every call in the `supervised` mode, so every WRITE
 * needs the person's confirmation (assist_pending_*) before its handler
 * can run; a READ runs directly. A tool missing from this map is
 * DANGEROUS to the registry and has no handler, so the router denies it.
 *
 * The argument parsers are strict (exact keys, exact types): the run
 * route re-reads what the browser sends back, and the guard compares its
 * hash with the one the person confirmed.
 */
import {
  ToolRegistry,
  type AutonomyMode,
  type ToolSpec,
} from '@/lib/assist/registry';
import { TASK_TITLE_MAX } from '@/lib/tasks/types';
import { NOTE_MAX_LENGTH } from '@/lib/inbox/notes';

/** Every panel call runs supervised: a WRITE always waits for a person. */
export const CHAT_ASSIST_MODE: AutonomyMode = 'supervised';

export const CHAT_ASSIST_READ_TOOL = 'chat_read';
export const CHAT_ASSIST_WRITE_TOOLS = [
  'chat_set_tag',
  'chat_create_task',
  'chat_assign',
  'chat_add_note',
] as const;
export type ChatAssistWriteTool = (typeof CHAT_ASSIST_WRITE_TOOLS)[number];
export type ChatAssistTool = ChatAssistWriteTool | typeof CHAT_ASSIST_READ_TOOL;

export interface ReadArgs {
  conversationId: string;
}
export interface SetTagArgs {
  conversationId: string;
  tagId: string;
  subTagId: string | null;
}
export interface CreateTaskArgs {
  conversationId: string;
  title: string;
  dueAt: string | null;
}
export interface AssignArgs {
  conversationId: string;
  expected: string | null;
  userId: string;
}
export interface AddNoteArgs {
  conversationId: string;
  body: string;
}

export type ToolArgs = {
  chat_read: ReadArgs;
  chat_set_tag: SetTagArgs;
  chat_create_task: CreateTaskArgs;
  chat_assign: AssignArgs;
  chat_add_note: AddNoteArgs;
};

/** A note the assistant proposes: shorter than a person's (4000). */
export const CHAT_ASSIST_NOTE_MAX = Math.min(1_000, NOTE_MAX_LENGTH);
export const CHAT_ASSIST_TASK_TITLE_MAX = Math.min(120, TASK_TITLE_MAX);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() !== '' && v === v.trim() && v.length <= max;

function exactKeys(
  v: unknown,
  keys: readonly string[]
): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

/**
 * The arguments of `tool`, if `raw` is exactly that tool's shape; else
 * null. Used on the way out (cards) and on the way back (the run route).
 */
export function parseToolArgs<T extends ChatAssistTool>(
  tool: T,
  raw: unknown
): ToolArgs[T] | null {
  switch (tool as ChatAssistTool) {
    case 'chat_read':
      return exactKeys(raw, ['conversationId']) && isId(raw.conversationId)
        ? (raw as unknown as ToolArgs[T])
        : null;
    case 'chat_set_tag':
      return exactKeys(raw, ['conversationId', 'tagId', 'subTagId']) &&
        isId(raw.conversationId) &&
        isId(raw.tagId) &&
        (raw.subTagId === null || isId(raw.subTagId))
        ? (raw as unknown as ToolArgs[T])
        : null;
    case 'chat_create_task':
      return exactKeys(raw, ['conversationId', 'title', 'dueAt']) &&
        isId(raw.conversationId) &&
        isText(raw.title, CHAT_ASSIST_TASK_TITLE_MAX) &&
        (raw.dueAt === null ||
          (typeof raw.dueAt === 'string' &&
            ISO_UTC.test(raw.dueAt) &&
            Number.isFinite(Date.parse(raw.dueAt))))
        ? (raw as unknown as ToolArgs[T])
        : null;
    case 'chat_assign':
      return exactKeys(raw, ['conversationId', 'expected', 'userId']) &&
        isId(raw.conversationId) &&
        isId(raw.userId) &&
        (raw.expected === null || isId(raw.expected))
        ? (raw as unknown as ToolArgs[T])
        : null;
    case 'chat_add_note':
      return exactKeys(raw, ['conversationId', 'body']) &&
        isId(raw.conversationId) &&
        isText(raw.body, CHAT_ASSIST_NOTE_MAX)
        ? (raw as unknown as ToolArgs[T])
        : null;
    default:
      return null;
  }
}

export function isChatAssistWriteTool(v: unknown): v is ChatAssistWriteTool {
  return (CHAT_ASSIST_WRITE_TOOLS as readonly unknown[]).includes(v);
}

const field = (label: string, v: unknown): readonly [string, string] => [
  label,
  v === null || v === undefined ? '-' : String(v),
];

/**
 * The registry the panel's guard uses: these tools and nothing else.
 * The confirmation prompt (`buildHumanPrompt`) names fields, never the
 * conversation id twice over.
 */
export const CHAT_ASSIST_TOOL_SPECS: Readonly<
  Record<ChatAssistTool, ToolSpec>
> = {
  chat_read: { risk: 'READ', displayName: 'Read the chat' },
  chat_set_tag: {
    risk: 'WRITE',
    displayName: 'Set the chat tag',
    describeArgs: (a) => {
      const x = a as Partial<SetTagArgs>;
      return [field('tag', x.tagId), field('sub-tag', x.subTagId)];
    },
  },
  chat_create_task: {
    risk: 'WRITE',
    displayName: 'Create a follow-up task',
    describeArgs: (a) => {
      const x = a as Partial<CreateTaskArgs>;
      return [field('title', x.title), field('due', x.dueAt)];
    },
  },
  chat_assign: {
    risk: 'WRITE',
    displayName: 'Assign the chat',
    describeArgs: (a) => {
      const x = a as Partial<AssignArgs>;
      return [field('to', x.userId), field('from', x.expected)];
    },
  },
  chat_add_note: {
    risk: 'WRITE',
    displayName: 'Add an internal note',
    describeArgs: (a) => [field('note', (a as Partial<AddNoteArgs>).body)],
  },
};

export function chatAssistRegistry(): ToolRegistry {
  return new ToolRegistry(CHAT_ASSIST_TOOL_SPECS);
}

/**
 * The nonce in a confirmation prompt (`buildHumanPrompt`'s footer:
 * "Reply CONFIRM <nonce> …"). The prompt is the human channel's; the
 * panel shows the person a card and keeps the nonce for their click.
 * Null when the prompt carries none.
 */
export function nonceFromHumanPrompt(prompt: string): string | null {
  // Only the footer, the prompt's last line: argument lines carry text
  // the model chose (one cannot break a line, `cleanText`), so a "CONFIRM
  // <hex>" inside a note must never be taken for the nonce.
  const last = prompt.slice(prompt.lastIndexOf('\n') + 1);
  const m = /^Reply CONFIRM ([0-9a-f]{20}) to allow it once, or DENY \1\./.exec(
    last
  );
  return m ? m[1] : null;
}
