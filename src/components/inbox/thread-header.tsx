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
  Share2,
  Smartphone,
  UserPlus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  assignChangeKind,
  type AssignChangeKind,
} from '@/lib/inbox/assign-confirm';
import type { ConversationHandler } from '@/lib/inbox/handler';
import { cn } from '@/lib/utils';
import type { Contact, Profile } from '@/types';
import type {
  ConversationListContact,
  ConversationListItem,
} from '@/lib/inbox/conversations';

import { ContactAvatar } from './contact-avatar';
import { ShareToChatButton } from '@/components/chat/share-to-chat-dialog';
import { CallButton } from '@/components/pbx/call-button';
import { useAuth } from '@/hooks/use-auth';
import { useMemberLoads } from '@/hooks/use-member-loads';
import { formatMemberLoad, isAtLimit } from '@/lib/assignment/ui';
import { isShareOnlyViewer } from '@/lib/coordinators/ui';
import { ChatReminderButton } from './chat-reminder-button';
import { CoordinatorShareButton } from './coordinator-share-button';
import { ThreadChannelSwitcher } from './thread-channel-switcher';
import { MemberPresenceDot } from './thread-presence';
import { ThreadTagBar, type ChatTagRowPatch } from './thread-tag-bar';

/** Round icon button in the thread header, WhatsApp-style. */
const HEADER_ICON_BUTTON =
  'text-wa-icon hover:bg-wa-icon-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors';

/** The small caption at the top of a header menu. */
const MENU_HEADING = 'text-muted-foreground px-2 py-1.5 text-xs';

export interface ThreadHeaderProps {
  /** The open chat; its list row is enough for everything here. */
  conversation: ConversationListItem;
  contact: ConversationListContact;
  /**
   * The whole contact, once the chat's full row has been read. The Call
   * button waits for it: its do-not-contact check reads columns the
   * list row does not carry, so it must not be offered before then.
   */
  fullContact: Contact | null;
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
  /** The current assignee's name, for the confirmation's wording. */
  assignedAgentName: string | null;
  currentUserId: string | null;
  /** Called only after the person confirms the change. */
  onAssign: (agentId: string | null) => void;
  onChatTagsChange: (conversationId: string, patch: ChatTagRowPatch) => void;
  /** The refresh button renders only when this is provided. */
  onRefresh?: () => void;
  isRefreshing: boolean;
  contactPanelOpen?: boolean;
  /** Desktop contact-panel toggle; renders only when provided. */
  onToggleContactPanel?: () => void;
  /** The bank this chat was shared with the viewer under (migration 133). */
  sharedBank?: string | null;
}

export function ThreadHeader({
  conversation,
  contact,
  fullContact,
  displayName,
  onBack,
  onChannelSwitched,
  handler,
  handlerPillName,
  handlerTitle,
  assignableProfiles,
  assignedAgentId,
  assignedAgentName,
  currentUserId,
  onAssign,
  onChatTagsChange,
  onRefresh,
  isRefreshing,
  contactPanelOpen,
  onToggleContactPanel,
  sharedBank = null,
}: ThreadHeaderProps) {
  const t = useTranslations('Inbox.messageThread');
  const tShare = useTranslations('Coordinators.share');
  const tLoad = useTranslations('ChatAssignment.load');
  // Each person's open chats and limit (migration 236), asked when the
  // Assign menu opens.
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const memberLoads = useMemberLoads(assignMenuOpen);
  const { accountRole } = useAuth();
  const shareOnly = isShareOnlyViewer(
    accountRole,
    currentUserId,
    conversation,
    !!sharedBank
  );

  // A personal chat (migration 191) stays on its owner's own number,
  // is never shared, and only its owner takes or releases it.
  const personalOwnerId = conversation.personal_owner_id ?? null;
  const isPersonalOwner =
    personalOwnerId !== null && personalOwnerId === currentUserId;
  const personalLabel = !personalOwnerId
    ? null
    : isPersonalOwner
      ? t('personalMine')
      : t('personalOf', {
          name:
            assignableProfiles
              .find((p) => p.user_id === personalOwnerId)
              ?.full_name?.trim() || t('unknownAgent'),
        });
  const pillProfiles = personalOwnerId
    ? assignableProfiles.filter((p) => p.user_id === currentUserId)
    : assignableProfiles;

  // Assigning is one click in the menu, which made it easy to hand a
  // chat to the wrong person by accident, so every change is asked
  // first. The question remembers which chat it was asked about: one
  // that lands after the agent opened another chat is dropped.
  const [pendingAssign, setPendingAssign] = useState<{
    conversationId: string;
    kind: AssignChangeKind;
    agentId: string | null;
    name: string | null;
  } | null>(null);
  const askAssign = (agentId: string | null, name: string | null) => {
    const kind = assignChangeKind(assignedAgentId, agentId);
    if (!kind) return;
    setPendingAssign({ conversationId: conversation.id, kind, agentId, name });
  };
  const confirmAssign = () => {
    const pending = pendingAssign;
    setPendingAssign(null);
    if (!pending || pending.conversationId !== conversation.id) return;
    onAssign(pending.agentId);
  };
  const fromName = assignedAgentName ?? t('unknownAgent');
  const toName = pendingAssign?.name ?? '';

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
        {personalLabel && (
          <p className="text-info inline-flex items-center gap-1 text-[11px] leading-4 font-medium">
            <Smartphone className="h-3 w-3 shrink-0" />
            {personalLabel}
          </p>
        )}
        {sharedBank && (
          <p className="text-wa-teal inline-flex items-center gap-1 text-[11px] leading-4 font-medium">
            <Share2 className="h-3 w-3 shrink-0" />
            {tShare('sharedLabel', { bank: sharedBank })}
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
          {!personalOwnerId && (
            <ThreadChannelSwitcher
              // Remount per chat: an in-flight switch (and its rollback
              // or toast) must never land on the next chat opened.
              key={conversation.id}
              conversation={conversation}
              onSwitched={onChannelSwitched}
              locked={shareOnly}
            />
          )}

          {/* Who is on this chat, and the way to hand it to someone —
            one pill. It names the person to ask about this customer
            (the assignee, else whoever is replying, else the owner),
            which an Assign control alone could only do once somebody
            had pressed it; and it is never captioned "Assign", which
            made the header read as "nobody has this chat" when
            somebody plainly did. Green once formally assigned. */}
          {(!personalOwnerId || isPersonalOwner) && (
            <DropdownMenu onOpenChange={setAssignMenuOpen}>
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
                className="border-border bg-popover w-64 max-w-[calc(100vw-2rem)]"
              >
                <div className={MENU_HEADING}>{t('assignTo')}</div>
                {pillProfiles.length === 0 ? (
                  <DropdownMenuItem
                    disabled
                    className="text-muted-foreground text-sm"
                  >
                    {t('noTeammates')}
                  </DropdownMenuItem>
                ) : (
                  pillProfiles.map((p) => {
                    const isSelected = p.user_id === assignedAgentId;
                    const load = memberLoads.get(p.user_id);
                    const loadLabel = formatMemberLoad(load);
                    const atLimit = isAtLimit(load);
                    const loadTitle = !load
                      ? null
                      : load.chatLimit === null
                        ? tLoad('open', { count: load.openCount })
                        : tLoad(atLimit ? 'full' : 'openOf', {
                            count: load.openCount,
                            limit: load.chatLimit,
                          });
                    return (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() =>
                          askAssign(
                            p.user_id,
                            (p.full_name?.trim() ||
                              p.email ||
                              t('unknownAgent')) +
                              (p.user_id === currentUserId ? t('me') : '')
                          )
                        }
                        className={cn(
                          'text-sm',
                          isSelected
                            ? 'text-primary'
                            : 'text-popover-foreground'
                        )}
                      >
                        <MemberPresenceDot
                          userId={p.user_id}
                          className="mr-2"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {p.full_name}
                          {p.user_id === currentUserId ? t('me') : ''}
                        </span>
                        {loadLabel ? (
                          <span
                            title={loadTitle ?? undefined}
                            className={cn(
                              'ml-2 shrink-0 text-xs tabular-nums',
                              atLimit
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                            )}
                          >
                            <span aria-hidden="true">· {loadLabel}</span>
                            <span className="sr-only">{loadTitle}</span>
                          </span>
                        ) : null}
                        {isSelected && <Check className="ml-2 h-3 w-3" />}
                      </DropdownMenuItem>
                    );
                  })
                )}
                {assignedAgentId && (
                  <>
                    <DropdownMenuSeparator className="bg-border" />
                    <DropdownMenuItem
                      onClick={() => askAssign(null, null)}
                      className="text-muted-foreground text-sm"
                    >
                      {t('unassign')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <ConfirmDialog
            open={
              pendingAssign !== null &&
              pendingAssign.conversationId === conversation.id
            }
            onOpenChange={(open) => {
              if (!open) setPendingAssign(null);
            }}
            title={
              pendingAssign?.kind === 'reassign'
                ? t('confirmReassignTitle')
                : pendingAssign?.kind === 'unassign'
                  ? t('confirmUnassignTitle')
                  : t('confirmAssignTitle')
            }
            description={
              pendingAssign?.kind === 'reassign'
                ? t('confirmReassignBody', {
                    customer: displayName,
                    from: fromName,
                    to: toName,
                  })
                : pendingAssign?.kind === 'unassign'
                  ? t('confirmUnassignBody', {
                      customer: displayName,
                      name: fromName,
                    })
                  : t('confirmAssignBody', {
                      customer: displayName,
                      name: toName,
                    })
            }
            cancelLabel={t('confirmAssignCancel')}
            confirmLabel={
              pendingAssign?.kind === 'reassign'
                ? t('confirmReassignAction')
                : pendingAssign?.kind === 'unassign'
                  ? t('unassign')
                  : t('assign')
            }
            onConfirm={confirmAssign}
          />

          {fullContact && (
            <CallButton
              contact={fullContact}
              conversationId={conversation.id}
            />
          )}
          <ShareToChatButton conversationId={conversation.id} />
          {/* A follow-up task about this customer and chat. Not for a
            share-only coordinator: the task's links must be visible to
            the writer (can_link_task), and a share does not extend
            can_view_contact / can_view_conversation. */}
          {!shareOnly && (
            <ChatReminderButton
              key={`remind-${conversation.id}`}
              conversationId={conversation.id}
              contactId={contact.id}
              customerName={displayName}
              assignableProfiles={assignableProfiles}
              currentUserId={currentUserId}
            />
          )}
          {!shareOnly && !personalOwnerId && (
            <CoordinatorShareButton
              key={`coord-${conversation.id}`}
              conversationId={conversation.id}
            />
          )}

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
