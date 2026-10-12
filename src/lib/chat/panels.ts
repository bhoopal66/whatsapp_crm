/**
 * The /chat/<id> right column and jump-to-message URL state: ?thread=,
 * ?panel=members|pins and ?message=. One right column at a time, so
 * opening one closes the other. Also the Add-people picker's rows. Pure,
 * so it tests without a DOM.
 */
import { withParam } from './compose';
import { addCandidates, isGuestPerson, type AddRules } from './membership';
import { isUuid } from './mentions';
import type {
  ChannelKind,
  ChannelMember,
  ChatMessage,
  ChatPerson,
} from './types';

export type SidePanel = 'members' | 'pins';

export type RightColumn =
  { kind: 'thread'; rootId: string } | { kind: SidePanel } | null;

interface Params {
  get(key: string): string | null;
}

/** What the right column shows; a thread wins over a panel (it names a message). */
export function rightColumn(params: Params): RightColumn {
  const thread = params.get('thread');
  if (isUuid(thread)) return { kind: 'thread', rootId: thread };
  const panel = params.get('panel');
  return panel === 'members' || panel === 'pins' ? { kind: panel } : null;
}

/** The query string with `next` in the right column (null closes it); ?message= is kept. */
export function withRightColumn(search: string, next: RightColumn): string {
  const q = withParam(
    search,
    'thread',
    next?.kind === 'thread' ? next.rootId : null
  );
  return withParam(
    q,
    'panel',
    next && next.kind !== 'thread' ? next.kind : null
  );
}

/**
 * The query string of a jump to `m`. The main timeline holds only
 * top-level messages, so a reply opens its thread; a top-level message
 * closes any thread (else the timeline would focus that thread's root)
 * and keeps an open panel when `keepPanel` (false on a phone, where the
 * panel covers the timeline).
 */
export function jumpQuery(
  search: string,
  m: Pick<ChatMessage, 'id' | 'threadRootId'>,
  keepPanel: boolean
): string {
  const current = rightColumn(new URLSearchParams(search));
  const next: RightColumn = m.threadRootId
    ? { kind: 'thread', rootId: m.threadRootId }
    : keepPanel && current?.kind !== 'thread'
      ? current
      : null;
  return withParam(withRightColumn(search, next), 'message', m.id);
}

/**
 * The top-level message the main timeline brings into view for
 * ?message=: with a thread open it is the thread's root (a link to a
 * reply carries the root in ?thread=), else the message itself.
 */
export function timelineFocusId(params: Params): string | null {
  const message = params.get('message');
  if (!isUuid(message)) return null;
  const thread = params.get('thread');
  return isUuid(thread) ? thread : message;
}

/** Why a person in the Add-people list cannot be picked. */
export type PickBlock = 'guestTeam' | 'guestRole' | 'staffRole';

export interface PickRow {
  person: ChatPerson;
  block: PickBlock | null;
}

/**
 * The Add-people list: everyone not yet in the channel, those the rules
 * let the viewer add (addCandidates) first, then the rest with the
 * reason. Empty when the viewer may add nobody at all (`rules.block`).
 */
export function addPickerRows(
  people: readonly ChatPerson[],
  members: readonly Pick<ChannelMember, 'userId'>[],
  rules: AddRules,
  kind: ChannelKind
): PickRow[] {
  if (rules.block) return [];
  const allowed = new Set(
    addCandidates(people, members, rules).map((p) => p.userId.toLowerCase())
  );
  const outside = addCandidates(people, members, {
    staff: true,
    guests: true,
    block: null,
  });
  const reason = (p: ChatPerson): PickBlock | null =>
    allowed.has(p.userId.toLowerCase())
      ? null
      : isGuestPerson(p)
        ? kind === 'team'
          ? 'guestTeam'
          : 'guestRole'
        : 'staffRole';
  const rows = outside.map((person) => ({ person, block: reason(person) }));
  return [...rows.filter((r) => !r.block), ...rows.filter((r) => r.block)];
}
