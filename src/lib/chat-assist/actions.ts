/**
 * From the model's suggested actions to the cards a person confirms.
 *
 * The model names tags and teammates by ordinal only (`prompt.ts`). Here
 * each suggestion is checked against the lists the server built for this
 * caller and turned into one WRITE tool call with real ids, or dropped:
 * an unknown ordinal, a sub-tag of another tag, the tag the chat already
 * has, the person it is already assigned to, a blank or over-long text,
 * a second suggestion of the same kind. Nothing here runs anything: each
 * call goes to the guarded router, which holds it for the person.
 *
 * Pure, so every rule is tested.
 */
import { cleanText } from '@/lib/assist/confirm';

import {
  CHAT_ASSIST_MAX_SUGGESTIONS,
  type PromptMember,
  type PromptTag,
} from './prompt';
import {
  CHAT_ASSIST_NOTE_MAX,
  CHAT_ASSIST_TASK_TITLE_MAX,
  parseToolArgs,
  type ChatAssistWriteTool,
  type ToolArgs,
} from './tools';

/** What the server knows about one main tag (ids stay here). */
export interface TagRef extends PromptTag {
  id: string;
  subs: (PromptTag['subs'][number] & { id: string })[];
}

/** One teammate the caller may assign the chat to (ids stay here). */
export interface MemberRef extends PromptMember {
  userId: string;
}

export interface SuggestionRefs {
  conversationId: string;
  tags: readonly TagRef[];
  members: readonly MemberRef[];
  currentTagId: string | null;
  currentSubTagId: string | null;
  assignedTo: string | null;
  /** For a task's due time. */
  now: number;
}

/** What the person sees on a card (names, never ids alone). */
export type CardView =
  | { kind: 'tag'; tagName: string; subTagName: string | null }
  | { kind: 'task'; title: string; dueAt: string | null }
  | { kind: 'assign'; memberName: string }
  | { kind: 'note'; body: string };

export interface PlannedAction<
  T extends ChatAssistWriteTool = ChatAssistWriteTool,
> {
  tool: T;
  args: ToolArgs[T];
  view: CardView;
  /** The model's one-line reason, cleaned and clipped; '' for none. */
  why: string;
}

const WHY_MAX = 200;
const MAX_DUE_HOURS = 720;

/** The model's JSON, tolerating a code fence or prose around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? cleanText(v) : '');
const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

/**
 * The suggestions worth a card, in the model's order, at most
 * `CHAT_ASSIST_MAX_SUGGESTIONS`, one per kind.
 */
export function planActions(
  modelText: string,
  refs: SuggestionRefs
): PlannedAction[] {
  const parsed = extractJson(modelText);
  const list =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { actions?: unknown }).actions
      : null;
  if (!Array.isArray(list)) return [];

  const out: PlannedAction[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (out.length >= CHAT_ASSIST_MAX_SUGGESTIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type : '';
    if (seen.has(type)) continue;
    const planned = planOne(type, s, refs);
    if (!planned) continue;
    seen.add(type);
    out.push(planned);
  }
  return out;
}

function planOne(
  type: string,
  s: Record<string, unknown>,
  refs: SuggestionRefs
): PlannedAction | null {
  const why = clip(str(s.why), WHY_MAX);
  const conversationId = refs.conversationId;
  switch (type) {
    case 'tag': {
      const tag = refs.tags.find((t) => t.ordinal === str(s.tag));
      if (!tag) return null;
      let sub: TagRef['subs'][number] | null = null;
      if (s.sub !== null && s.sub !== undefined && str(s.sub) !== '') {
        sub = tag.subs.find((x) => x.ordinal === str(s.sub)) ?? null;
        if (!sub) return null; // a sub-tag of another tag, or made up
      }
      if (
        tag.id === refs.currentTagId &&
        (sub?.id ?? null) === refs.currentSubTagId
      )
        return null; // already so
      const args = parseToolArgs('chat_set_tag', {
        conversationId,
        tagId: tag.id,
        subTagId: sub?.id ?? null,
      });
      return args
        ? {
            tool: 'chat_set_tag',
            args,
            view: {
              kind: 'tag',
              tagName: tag.name,
              subTagName: sub?.name ?? null,
            },
            why,
          }
        : null;
    }
    case 'task': {
      const title = clip(str(s.title), CHAT_ASSIST_TASK_TITLE_MAX);
      if (!title) return null;
      const h = Number(s.due_in_hours);
      const dueAt =
        Number.isFinite(h) && h >= 1 && h <= MAX_DUE_HOURS
          ? new Date(refs.now + Math.round(h) * 3_600_000).toISOString()
          : null;
      const args = parseToolArgs('chat_create_task', {
        conversationId,
        title,
        dueAt,
      });
      return args
        ? {
            tool: 'chat_create_task',
            args,
            view: { kind: 'task', title, dueAt },
            why,
          }
        : null;
    }
    case 'assign': {
      const m = refs.members.find((x) => x.ordinal === str(s.member));
      if (!m || m.userId === refs.assignedTo) return null;
      const args = parseToolArgs('chat_assign', {
        conversationId,
        expected: refs.assignedTo,
        userId: m.userId,
      });
      return args
        ? {
            tool: 'chat_assign',
            args,
            view: { kind: 'assign', memberName: m.name },
            why,
          }
        : null;
    }
    case 'note': {
      // A note keeps its line breaks; only control characters go.
      const body = clip(
        typeof s.text === 'string'
          ? s.text
              .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? '\n' : ' '))
              .trim()
          : '',
        CHAT_ASSIST_NOTE_MAX
      ).trim();
      if (!body) return null;
      const args = parseToolArgs('chat_add_note', { conversationId, body });
      return args
        ? { tool: 'chat_add_note', args, view: { kind: 'note', body }, why }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Ordinal lists for the prompt from the workspace's tags and the
 * teammates the caller may assign to. Main tags are T1…Tn in the order
 * given; sub-tags T<n>.1…; members M1…Mn.
 */
export function buildRefs(args: {
  tags: readonly { id: string; name: string; parent_id: string | null }[];
  members: readonly { userId: string; name: string }[];
}): { tags: TagRef[]; members: MemberRef[] } {
  const mains = args.tags.filter((t) => t.parent_id === null);
  const tags: TagRef[] = mains.map((t, i) => {
    const ordinal = `T${i + 1}`;
    return {
      ordinal,
      id: t.id,
      name: t.name,
      subs: args.tags
        .filter((s) => s.parent_id === t.id)
        .map((s, j) => ({
          ordinal: `${ordinal}.${j + 1}`,
          id: s.id,
          name: s.name,
        })),
    };
  });
  const members: MemberRef[] = args.members.map((m, i) => ({
    ordinal: `M${i + 1}`,
    userId: m.userId,
    name: m.name,
  }));
  return { tags, members };
}

/** The current tag as the prompt names it ("T2.1"), or null. */
export function currentTagOrdinal(
  tags: readonly TagRef[],
  tagId: string | null,
  subTagId: string | null
): string | null {
  const t = tags.find((x) => x.id === tagId);
  if (!t) return null;
  const s = t.subs.find((x) => x.id === subTagId);
  return s ? s.ordinal : t.ordinal;
}
