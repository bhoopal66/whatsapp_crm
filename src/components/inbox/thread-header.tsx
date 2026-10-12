'use client';

// ============================================================
// The chat screen's top bar, in two rows on one grey background:
//
//   1. who the customer is (avatar, name, number), and what the team
//      does with the chat: which of our numbers it sends from, who is
//      on it, then the two view utilities (refresh, contact panel).
//   2. the chat's tags (`ThreadTagBar`), which replaced the
//      Open/Pending/Closed control.
//
// Presentational: `MessageThread` loads the messages and members and
// hands down what to show. The tag row reads its own reference data.
// ============================================================

import {
  ArrowLeft,
  Check,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  UserPlus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationHandler } from '@/lib/inbox/handler';
import { cn } from '@/lib/utils';
import type { Contact, Conversation, Profile } from '@/types';

import { ContactAvatar } from './contact-avatar';
import { ShareToChatButton } from '@/components/chat/share-to-chat-dialog';
import { ThreadChannelSwitcher } from './thread-channel-switcher';
import { MemberPresenceDot } from './thread-presence';
import { ThreadTagBar, type ChatTagsPatch } from './thread-tag-bar';

/** Round icon button in the thread header, WhatsApp-style. */
const HEADER_ICON_BUTTON =
  'text-wa-icon hover:bg-wa-icon-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors';

/** The small caption at the top of a header menu. */
const MENU_HEADING = 'text-muted-foreground px-2 py-1.5 text-xs';

export interface ThreadHeaderProps {
  conversation: Conversation;
  contact: Contact;
  /** The contact's name, else their number. */
  displayName: string;
  /** Mobile back-to-list; rendered below lg only. */
  onBack?: () => void;
  /** After this user switched the sending number (reloads the notes). */
  onChannelSwitched: () => void;
  /** Who to name on the assignee pill, and why (see MessageThread). */
  handler: ConversationHandler | null;
  /** "Me", or their name; `handlerTitle` says the rest. */
  handlerPillName: string | null;
  handlerTitle: string;
  /** Who this person may hand the chat to. */
  assignableProfiles: Profile[];
  assignedAgentId: string | null;
  currentUserId: string | null;
  onAssign: (agentId: string | null) => void;
  onChatTagsChange: (conversationId: string, patch: ChatTagsPatch) => void;
  /** The refresh button renders only when this is provided. */
  onRefresh?: () => void;
  isRefreshing: boolean;
  contactPanelOpen?: boolean;
  /** Desktop contact-panel toggle; renders only when provided. */
  onToggleContactPanel?: () => void;
}

export function ThreadHeader({
  conversation,
  contact,
  displayName,
  onBack,
  onChannelSwitched,
  handler,
  handlerPillName,
  handlerTitle,
  assignableProfiles,
  assignedAgentId,
  currentUserId,
  onAssign,
  onChatTagsChange,
  onRefresh,
  isRefreshing,
  contactPanelOpen,
  onToggleContactPanel,
}: ThreadHeaderProps) {
  const t = useTranslations('Inbox.messageThread');

  const identity = (
    <>
      <ContactAvatar contact={contact} name={displayName} size={40} />
      <div className="min-w-0">
        <h2 className="text-wa-text truncate text-[15px] leading-5 font-medium">
          {displayName}
        </h2>
        {/* The number, unless it is already the name. */}
        {contact.name && (
          <p className="text-wa-text-secondary truncate text-xs leading-4">
            {contact.phone}
          </p>
        )}
      </div>
    </>
  );

  return (
    // WhatsApp's grey bar, solid so the wallpaper never shows through.
    <div className="bg-wa-panel-header border-wa-divider shrink-0 border-b">
      {/* Row 1: the customer on the left; the number, the person on
        the chat, and past a hairline the two view utilities (refresh,
        contact panel) at the far right. */}
      <div className="flex min-h-[60px] items-center justify-between gap-2 px-2 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 @lg/thread:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
            conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className={cn(HEADER_ICON_BUTTON, 'lg:hidden')}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          {/* The customer. On lg+ it opens and closes the contact panel,
            the way WhatsApp opens contact info from the chat title.
            Below lg there is no panel to toggle (the page renders it
            lg+ only), so there it is plain text: a button that merely
            ignored the pointer still took focus, and Enter flipped
            state nobody could see. `hidden` takes the other copy out of
            the tab order and the accessibility tree. */}
          {onToggleContactPanel ? (
            <>
              <div className="flex min-w-0 items-center gap-2 lg:hidden @lg/thread:gap-3">
                {identity}
              </div>
              <button
                type="button"
                onClick={onToggleContactPanel}
                title={t('contactInfo')}
                aria-pressed={contactPanelOpen}
                className="hover:bg-wa-icon-hover -mx-1 hidden min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors lg:flex @lg/thread:gap-3"
              >
                {identity}
              </button>
            </>
          ) : (
            <div className="flex min-w-0 items-center gap-2 @lg/thread:gap-3">
              {identity}
            </div>
          )}
        </div>

        {/* Right-hand controls. Each folds down as the thread narrows
          (container queries on `@container/thread`), so the contact's
          name always keeps its room: labels go first, then the
          refresh button. The number and the person are the same h-8
          pill so the pair reads as one set. */}
        <div className="flex shrink-0 items-center gap-1 @lg/thread:gap-1.5">
          {/* Which number this chat sends from (migration 061):
            automatic, or pinned by a person to one they may use. */}
          <ThreadChannelSwitcher
            // Remount per chat: an in-flight switch (and its rollback
            // or toast) must never land on the next chat opened.
            key={conversation.id}
            conversation={conversation}
            onSwitched={onChannelSwitched}
          />

          {/* Who is on this chat, and the way to hand it to someone —
            one pill. It names the person to ask about this customer
            (the assignee, else whoever is replying, else the owner),
            which an Assign control alone could only do once somebody
            had pressed it; and it is never captioned "Assign", which
            made the header read as "nobody has this chat" when
            somebody plainly did. Green once formally assigned. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={handlerTitle}
              aria-label={`${t('assign')}: ${handlerTitle}`}
              className={cn(
                'inline-flex h-8 max-w-[6.5rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors @md/thread:max-w-[8.5rem] @2xl/thread:max-w-[11rem]',
                handler?.kind === 'assigned'
                  ? 'bg-wa-chip-active text-wa-teal border-transparent'
                  : 'border-wa-divider bg-wa-panel text-wa-text-secondary hover:bg-wa-row-hover'
              )}
            >
              {handler ? (
                <MemberPresenceDot userId={handler.userId} />
              ) : (
                <UserPlus className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">
                {handler ? handlerPillName : t('unassigned')}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover w-56"
            >
              <div className={MENU_HEADING}>{t('assignTo')}</div>
              {assignableProfiles.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="text-muted-foreground text-sm"
                >
                  {t('noTeammates')}
                </DropdownMenuItem>
              ) : (
                assignableProfiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => onAssign(p.user_id)}
                      className={cn(
                        'text-sm',
                        isSelected ? 'text-primary' : 'text-popover-foreground'
                      )}
                    >
                      <MemberPresenceDot userId={p.user_id} className="mr-2" />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === currentUserId ? t('me') : ''}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => onAssign(null)}
                    className="text-muted-foreground text-sm"
                  >
                    {t('unassign')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <ShareToChatButton conversationId={conversation.id} />

          {onRefresh && (
            <span
              aria-hidden="true"
              className="bg-wa-divider mx-0.5 hidden h-6 w-px @lg/thread:block"
            />
          )}

          {/* Manual refresh — forces a refetch of the messages + the
            conversation list (the parent bumps its resyncToken). Useful
            when realtime missed an event or the agent just wants to be
            sure nothing's stale. Only rendered when the parent wires
            up `onRefresh`, and folded away in a narrow thread, where
            the contact's name needs the room more (realtime and the
            reconnect resync still keep the thread current). */}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label={t('refreshConversation')}
              title={t('refresh')}
              className={cn(
                HEADER_ICON_BUTTON,
                'hidden disabled:opacity-60 @lg/thread:inline-flex'
              )}
            >
              <RefreshCw
                className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
              />
            </button>
          )}

          {/* Contact-panel toggle — desktop only. The contact sidebar
            eats a chunk of horizontal width that crowds the thread on
            smaller laptops; this lets agents reclaim it when they just
            want to read and reply. Hidden on mobile, where the sidebar
            never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t('hideContactPanel') : t('showContactPanel')
              }
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              aria-pressed={contactPanelOpen}
              className={cn(
                HEADER_ICON_BUTTON,
                'hidden lg:inline-flex',
                contactPanelOpen && 'bg-wa-icon-hover'
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Row 2: the chat's tags. Remounted per chat like the number
        switcher: an in-flight save (and its rollback or toast) must
        never land on the next chat opened. */}
      <ThreadTagBar
        key={conversation.id}
        conversation={conversation}
        onChatTagsChange={onChatTagsChange}
      />
    </div>
  );
}
