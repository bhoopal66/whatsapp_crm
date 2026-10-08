'use client';

// ============================================================
// Which WhatsApp number this chat sends from — picked in the thread
// header, on any chat, mid-conversation (migration 061).
//
//   * Automatic (every chat until someone changes it): replies go out
//     on the number the customer last wrote to.
//   * A number: everything in this chat goes out from it until someone
//     switches again.
//
// A person only sees the numbers they may use — every number for an
// admin; otherwise the ones they are allocated to in Settings →
// Numbers & access, plus shared ones. The database enforces the same
// rule (`can_use_channel`); this only decides what to offer.
//
// Each switch leaves a note in the thread (`ThreadChannelNote`), for
// whoever reads the chat next.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Loader2,
  Phone,
  Pin,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  channelDisplayName,
  channelNameWithPhone,
  usableNumbers,
} from '@/lib/whatsapp/channel-management';
import {
  useAccountNumbers,
  useAllNumberAllocations,
  type AccountNumber,
} from '@/hooks/use-whatsapp-numbers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Conversation, ConversationEvent } from '@/types';

/**
 * The chat's timeline notes, loaded once per conversation and kept
 * live over realtime. `reload` is for right after this user switched,
 * so their own note appears even if the realtime event is slow.
 */
async function fetchConversationEvents(
  conversationId: string
): Promise<ConversationEvent[]> {
  const { data } = await createClient()
    .from('conversation_events')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return (data ?? []) as ConversationEvent[];
}

export function useConversationEvents(conversationId: string | null) {
  // Tagged with the conversation it describes, so switching chats can
  // never show the previous chat's notes while the new ones load.
  const [state, setState] = useState<{
    conversationId: string | null;
    events: ConversationEvent[];
  }>({ conversationId: null, events: [] });

  // The chat on screen right now. A reload started for one chat must
  // not land after the user has moved to another.
  const currentIdRef = useRef(conversationId);
  useEffect(() => {
    currentIdRef.current = conversationId;
  }, [conversationId]);

  const reload = useCallback(async () => {
    if (!conversationId) return;
    const events = await fetchConversationEvents(conversationId);
    if (currentIdRef.current !== conversationId) return;
    setState({ conversationId, events });
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    fetchConversationEvents(conversationId).then((events) => {
      if (!cancelled) setState({ conversationId, events });
    });
    const supabase = createClient();
    // A unique topic per subscription: realtime-js hands back the SAME
    // channel for a repeated name, and one that is still leaving (a
    // quick A → B → A, or StrictMode's double mount) would be reused,
    // never re-joined, and go silently dead.
    const channel = supabase
      .channel(
        `conversation-events:${conversationId}:${Math.random().toString(36).slice(2)}`
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversation_events',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as ConversationEvent;
          // A note can arrive before the initial fetch lands; start this
          // chat's list rather than dropping it. The fetch then replaces
          // the list with the full set, which includes this row.
          setState((prev) => {
            const events =
              prev.conversationId === conversationId ? prev.events : [];
            return events.some((e) => e.id === row.id)
              ? prev
              : { conversationId, events: [...events, row] };
          });
        }
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const events = useMemo(
    () => (state.conversationId === conversationId ? state.events : []),
    [state, conversationId]
  );
  return { events, reload };
}

interface SwitcherProps {
  conversation: Conversation;
  /** Called after a successful switch, to refresh the timeline notes. */
  onSwitched?: () => void;
}

export function ThreadChannelSwitcher({
  conversation,
  onSwitched,
}: SwitcherProps) {
  const t = useTranslations('Inbox.channelSwitch');
  const { user, accountRole } = useAuth();
  const numbers = useAccountNumbers();
  const allocations = useAllNumberAllocations();

  // The pin as this screen knows it. Seeded from the conversation and
  // re-synced whenever realtime brings a newer row (another agent may
  // switch the same chat), and set optimistically on our own switch.
  const [pin, setPin] = useState<string | null>(
    conversation.send_channel_id ?? null
  );
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPin(conversation.send_channel_id ?? null);
  }, [conversation.id, conversation.send_channel_id]);

  const isAdmin = !!accountRole && hasMinRole(accountRole, 'admin');
  const options = useMemo(
    () =>
      usableNumbers(
        numbers ?? [],
        allocations ?? [],
        user?.id ?? null,
        isAdmin
      ),
    [numbers, allocations, user?.id, isAdmin]
  );

  // One number on the account: there is nothing to switch between.
  if (!numbers || numbers.length < 2) return null;

  const byId = new Map(numbers.map((n) => [n.id, n]));
  const pinned = pin ? byId.get(pin) : undefined;
  const home = conversation.channel_id
    ? byId.get(conversation.channel_id)
    : undefined;
  const mayUseViewer = accountRole !== 'viewer';

  async function choose(next: string | null) {
    if (next === pin || saving) return;
    const previous = pin;
    setPin(next);
    setSaving(true);
    try {
      const res = await fetch(
        `/api/whatsapp/conversations/${conversation.id}/channel`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_id: next }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPin(previous);
        toast.error(body?.error || t('failed'));
        return;
      }
      const target = next ? byId.get(next) : undefined;
      toast.success(
        target
          ? t('switchedTo', { name: channelNameWithPhone(target) })
          : t('switchedAuto')
      );
      onSwitched?.();
    } catch {
      setPin(previous);
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  const triggerLabel = pinned
    ? channelNameWithPhone(pinned)
    : home
      ? t('autoWith', { name: channelNameWithPhone(home) })
      : t('auto');
  // A mid-width thread gets the number's name alone: the full label
  // ("Auto · Sales · +9715…") cut the customer's name in the header
  // down to a few letters. The full label is back once the thread is
  // wide, and always in the tooltip and the menu, which is where the
  // handset a reply leaves on matters.
  const shortLabel = pinned
    ? channelDisplayName(pinned)
    : home
      ? channelDisplayName(home)
      : t('auto');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!mayUseViewer}
        title={`${triggerLabel}. ${pinned ? t('pinnedTitle') : t('autoTitle')}`}
        aria-label={`${t('label')}: ${triggerLabel}`}
        className={cn(
          // Icon-only in a narrow thread: the header already holds
          // refresh, handler, status and assign, and a label here pushed
          // the contact's name to zero width on a 360px screen. Keyed on
          // the thread's width (`@container/thread` in message-thread),
          // which beside the list and contact panel is narrow on a
          // wide screen too.
          'inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors @xl/thread:max-w-[13rem] @3xl/thread:max-w-[20rem]',
          pinned
            ? 'bg-wa-chip-active text-wa-teal border-transparent'
            : 'border-wa-divider bg-wa-panel text-wa-text-secondary hover:bg-wa-row-hover'
        )}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : pinned ? (
          <Pin className="h-3 w-3 shrink-0" />
        ) : (
          <Phone className="h-3 w-3 shrink-0" />
        )}
        <span className="hidden truncate @xl/thread:inline @3xl/thread:hidden">
          {shortLabel}
        </span>
        <span className="hidden truncate @3xl/thread:inline">
          {triggerLabel}
        </span>
        <ChevronDown className="hidden h-3 w-3 shrink-0 @xl/thread:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="border-border bg-popover w-72"
      >
        <div className="text-muted-foreground px-2 py-1.5 text-xs">
          {t('heading')}
        </div>
        <DropdownMenuItem onClick={() => void choose(null)} className="text-sm">
          <span className="flex-1">
            {t('auto')}
            <span className="text-muted-foreground block text-xs">
              {home
                ? t('autoHintWith', { name: channelNameWithPhone(home) })
                : t('autoHint')}
            </span>
          </span>
          {!pin && <Check className="ml-2 h-3 w-3" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-border" />
        {options.length === 0 ? (
          <DropdownMenuItem disabled className="text-muted-foreground text-sm">
            {t('noNumbers')}
          </DropdownMenuItem>
        ) : (
          options.map((n: AccountNumber) => (
            <DropdownMenuItem
              key={n.id}
              onClick={() => void choose(n.id)}
              className="text-sm"
            >
              <span className="flex-1">
                {channelNameWithPhone(n)}
                <span className="text-muted-foreground block text-xs">
                  {n.provider === 'meta' ? t('metaHint') : t('whapiHint')}
                </span>
              </span>
              {pin === n.id && <Check className="ml-2 h-3 w-3" />}
            </DropdownMenuItem>
          ))
        )}
        {/* Pinned by someone else to a number this user may not use:
            show it, so the header never lies about where messages go. */}
        {pinned && !options.some((o) => o.id === pinned.id) && (
          <DropdownMenuItem disabled className="text-sm">
            <span className="flex-1">{channelNameWithPhone(pinned)}</span>
            <Check className="ml-2 h-3 w-3" />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A switch, as it reads in the thread. Centred like the date separators. */
export function ThreadChannelNote({
  event,
  actorName,
  isMe,
}: {
  event: ConversationEvent;
  actorName: string | null;
  isMe: boolean;
}) {
  const t = useTranslations('Inbox.channelSwitch');
  const who = isMe ? t('you') : actorName || t('someone');
  const time = new Date(event.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="my-3 flex justify-center" role="note">
      <span className="bg-wa-date-chip text-wa-date-chip-fg inline-flex max-w-[90%] items-center gap-1.5 rounded-lg px-3 py-1 text-[11.5px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
        <ArrowRightLeft className="h-3 w-3 shrink-0" />
        <span>
          {event.to_channel_id || event.to_label
            ? t('noteTo', { who, name: event.to_label ?? '' })
            : t('noteAuto', { who })}
          <span className="ml-1 opacity-70">· {time}</span>
        </span>
      </span>
    </div>
  );
}
