'use client';

// ============================================================
// The chat's tags (migration 075), the second row of the thread
// header: at most one main tag ("Interested customer") and, when that
// tag has sub-tags, at most one of them ("Bank: ADCB"). Admins set the
// tags up in Settings → Chat tags.
//
// The database is the authority: a trigger rejects a sub-tag that is
// not a child of the main tag and clears the sub-tag when only the
// main tag changes, and RLS lets agent+ write only chats they can see
// (a filtered UPDATE answers no row, not an error). So a save reports
// the row the server returned, never what was asked for.
//
// Mounted with `key={conversation.id}`: an in-flight save must never
// land on the next chat opened.
//
// Beside the tags sits Jev's suggestion (migration 147,
// docs/jev-insights.md): a chip with Apply and Dismiss, or a "Suggest a
// tag" button when no chip shows. Apply goes through the same `save()`
// as a pick, so automations, deal creation and the chain depth behave
// exactly as for a manual tag. Nothing shows while suggestions are off,
// and a viewer, who cannot tag, never sees either.
// ============================================================

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { useChatTags } from '@/hooks/use-chat-tags';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import { hasMinRole } from '@/lib/auth/roles';
import {
  resolveConversationChatTags,
  type ChatTagNode,
} from '@/lib/chat-tags/tree';
import {
  chatTagColor,
  chatTagMainStyle,
  chatTagSubStyle,
} from '@/lib/chat-tags/style';
import {
  ChatTagPill,
  PILL_MAIN_TEXT,
  PILL_SUB_TEXT,
  PillDot,
} from '@/components/inbox/chat-tag-pill';
import {
  canAskForSuggestion,
  shownSuggestion,
  suggestOutcome,
  suggestionKey,
  suggestionPercent,
  suggestionTagText,
  type ShownSuggestion,
  type TagSuggestionRow,
} from '@/lib/insights/suggestion-view';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { ChatTag, ChatTagRowPatch, ChatTagsPatch } from '@/types';
import type { ConversationListItem } from '@/lib/inbox/conversations';

export type { ChatTagRowPatch, ChatTagsPatch } from '@/types';

export const CHAT_TAGS_SETTINGS_HREF = '/settings?tab=chat-tags';

const CHIP =
  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors';
/** A tag that is set: a tint of its colour (the style sets the text). */
const CHIP_TINTED = 'hover:brightness-95';
/** The main tag with its sub-tag joined on: the pill's left half. */
const CHIP_LEFT = 'rounded-r-none border-r-0';
/** The sub-tag joined on to its main tag: the pill's right half. */
const CHIP_RIGHT = 'rounded-l-none';
/** Nothing set yet: an invitation, not a value. */
const CHIP_DASHED =
  'border-wa-divider text-wa-text-secondary hover:bg-wa-row-hover border-dashed';
/** The chip whose pick is being saved. */
const CHIP_BUSY = 'cursor-wait opacity-60';
const MENU_HEADING = 'text-muted-foreground px-2 py-1.5 text-xs';
/** Jev's suggestion: the info tone, so it reads as advice, not a tag. */
const SUGGESTION_CHIP =
  'border-info/30 bg-info-soft text-info inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full border pr-1 pl-2.5 text-xs font-medium';
const SUGGESTION_BUTTON =
  'hover:bg-info/15 inline-flex h-5 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60';
/** The suggestion columns a successful Apply or Dismiss leaves empty. */
const NO_SUGGESTION: ChatTagRowPatch = {
  suggested_chat_tag_id: null,
  suggested_chat_sub_tag_id: null,
  suggested_tag_p: null,
  suggested_tag_at: null,
};

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: chatTagColor(color) }}
    />
  );
}

export function ThreadTagBar({
  conversation,
  onChatTagsChange,
}: {
  /** A list row has no suggestion columns; the full row does. */
  conversation: ConversationListItem & TagSuggestionRow;
  onChatTagsChange: (conversationId: string, patch: ChatTagRowPatch) => void;
}) {
  const t = useTranslations('Inbox.chatTags');
  const ts = useTranslations('TagSuggest');
  const { accountRole } = useAuth();
  const { tags, tree, reload } = useChatTags();
  const { settings: insightSettings } = useInsightSettings();

  // The suggestion whose Apply or Dismiss is in flight, hidden at once
  // and shown again if it fails; and whether "Suggest a tag" is asking.
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // The pick being saved, shown at once; the props take over again
  // when the save settles either way.
  const [pending, setPending] = useState<ChatTagsPatch | null>(null);
  const savingRef = useRef(false);

  // Picking a main tag that has sub-tags opens the sub-tag menu next.
  // It waits for two things: the main menu to have finished closing
  // (so the two menus' focus handling don't fight), and the save to
  // have landed (neither menu opens while it is in flight).
  //
  // The sub-tag menu is open *for a main tag*, by id. A boolean
  // outlived the menu: a teammate's change could unmount it while
  // open, and it popped open by itself when a main tag with sub-tags
  // came back.
  const [subOpenFor, setSubOpenFor] = useState<string | null>(null);
  const followUp = useRef<{
    forTag: string | null;
    menuClosed: boolean;
    saved: boolean;
  }>({ forTag: null, menuClosed: false, saved: false });
  const maybeOpenSub = () => {
    const f = followUp.current;
    if (f.forTag && f.menuClosed && f.saved) {
      followUp.current = { forTag: null, menuClosed: false, saved: false };
      setSubOpenFor(f.forTag);
    }
  };

  const propIds: ChatTagsPatch = {
    chat_tag_id: conversation.chat_tag_id ?? null,
    chat_sub_tag_id: conversation.chat_sub_tag_id ?? null,
  };
  const shown = pending ?? propIds;
  const { main, sub } = resolveConversationChatTags(shown, tree);

  // The main tag whose sub-tag menu is on screen, if any. Once the
  // menu is gone, or shows another tag's sub-tags, it is closed for
  // good: forget it now, during render, so the same tag coming back
  // later does not reopen it.
  const subMenuFor = main && main.subs.length > 0 ? main.id : null;
  if (subOpenFor !== null && subOpenFor !== subMenuFor) setSubOpenFor(null);
  const subOpen = subOpenFor !== null && subOpenFor === subMenuFor;

  // A save in flight: neither menu opens until it settles, so a second
  // pick cannot be made (and silently dropped) meanwhile. The chips stay
  // focusable (`aria-disabled`, not `disabled`): the closing menu hands
  // focus back to its chip, and a natively disabled chip refused it, so
  // a keyboard user was dropped to the top of the page after every
  // pick. The chip being saved is the main one when the main tag
  // changes.
  const saving = pending !== null;
  const savingMain = saving && pending.chat_tag_id !== propIds.chat_tag_id;
  const [mainOpen, setMainOpen] = useState(false);

  // A chat tagged with an id the loaded list doesn't have: another
  // admin probably added it since the list was cached. Read the list
  // again, once per id; until then the chat shows as untagged.
  const staleId =
    tags !== null &&
    propIds.chat_tag_id &&
    !resolveConversationChatTags(propIds, tree).main
      ? propIds.chat_tag_id
      : null;
  const reloadedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!staleId || reloadedFor.current.has(staleId)) return;
    reloadedFor.current.add(staleId);
    void reload();
  }, [staleId, reload]);

  if (tags === null || !accountRole) return null;
  const isAdmin = hasMinRole(accountRole, 'admin');
  const canEdit = accountRole !== 'viewer';

  /** Resolves true once the server kept a row (whatever it kept). */
  async function save(
    next: ChatTagsPatch,
    openSubAfter: boolean
  ): Promise<boolean> {
    // A backstop: the menus already refuse to open while saving.
    if (savingRef.current) return false;
    savingRef.current = true;
    // Picks come from an open menu, which has not finished closing.
    followUp.current = {
      forTag: openSubAfter ? next.chat_tag_id : null,
      menuClosed: false,
      saved: false,
    };
    setPending(next);
    let saved: ChatTagsPatch | null = null;
    // A 400 carries a message meant for the person who picked.
    let refusal: string | null = null;
    try {
      // The route writes under this user's RLS and fires the account's
      // chat_tag_set automations; it answers the row the database kept.
      const res = await fetch(
        `/api/conversations/${conversation.id}/chat-tags`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        chat_tag_id?: string | null;
        chat_sub_tag_id?: string | null;
        error?: string;
      } | null;
      if (res.ok && data) {
        saved = {
          chat_tag_id: data.chat_tag_id ?? null,
          chat_sub_tag_id: data.chat_sub_tag_id ?? null,
        };
      } else {
        if (res.status === 400 && typeof data?.error === 'string') {
          refusal = data.error;
        }
        console.error('[chat-tags] save failed', res.status, data?.error);
      }
    } catch (err) {
      console.error('[chat-tags] save failed', err);
    } finally {
      savingRef.current = false;
      setPending(null);
    }
    if (!saved) {
      // A 404 is RLS saying no; either way the chip falls back to what
      // the chat really carries.
      followUp.current.forTag = null;
      toast.error(refusal ?? t('saveFailed'));
      return false;
    }
    onChatTagsChange(conversation.id, saved);
    if (saved.chat_tag_id === next.chat_tag_id) {
      followUp.current.saved = true;
      maybeOpenSub();
    } else {
      followUp.current.forTag = null;
    }
    return true;
  }

  // -- Jev's suggestion ---------------------------------------------
  const mode = insightSettings.tagSuggestMode;
  const suggestion = shownSuggestion(conversation, {
    mode,
    canEdit,
    hiddenKey,
  });
  // Named from the loaded tags; one the list doesn't have (yet) is not
  // shown rather than shown as an id.
  const suggestedMain = suggestion
    ? (tree.mains.find((m) => m.id === suggestion.mainId) ?? null)
    : null;
  const suggestedSub =
    suggestion?.subId && suggestedMain
      ? (suggestedMain.subs.find((s) => s.id === suggestion.subId) ?? null)
      : null;
  const chip =
    suggestion &&
    suggestedMain &&
    (suggestion.subId === null || suggestedSub !== null)
      ? suggestion
      : null;
  // No "Suggest a tag" either while a chip's Apply or Dismiss is in
  // flight: it would flash in for the moment the chip is hidden.
  const settling =
    hiddenKey !== null && hiddenKey === suggestionKey(conversation);
  const canAsk =
    canAskForSuggestion({ mode, canEdit, chipShown: chip !== null }) &&
    !saving &&
    !settling;

  function restoreChip(key: string) {
    setHiddenKey((k) => (k === key ? null : k));
  }

  async function applySuggestion(s: ShownSuggestion) {
    setHiddenKey(s.key);
    const ok = await save(
      { chat_tag_id: s.mainId, chat_sub_tag_id: s.subId ?? null },
      false
    );
    // save() has already said why it failed.
    if (!ok) return restoreChip(s.key);
    // The route cleared the suggestion with the tag change.
    onChatTagsChange(conversation.id, NO_SUGGESTION);
  }

  async function dismissSuggestion(s: ShownSuggestion) {
    setHiddenKey(s.key);
    let failed = true;
    try {
      const { error } = await createClient().rpc('dismiss_tag_suggestion', {
        p_conversation_id: conversation.id,
      });
      if (error) console.error('[tag-suggest] dismiss failed', error);
      else failed = false;
    } catch (err) {
      console.error('[tag-suggest] dismiss failed', err);
    }
    if (failed) {
      restoreChip(s.key);
      toast.error(ts('dismissFailed'));
      return;
    }
    onChatTagsChange(conversation.id, {
      ...NO_SUGGESTION,
      tag_suggestion_dismissed_id: s.mainId,
    });
  }

  async function askForSuggestion() {
    if (asking) return;
    setAsking(true);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch('/api/insights/tag-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id }),
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      console.error('[tag-suggest] ask failed', err);
    } finally {
      setAsking(false);
    }
    const outcome = suggestOutcome(status, body);
    if (outcome.kind === 'suggestion') {
      // The route stored it on the row too; realtime brings the exact
      // timestamp, which only renames the chip's key.
      onChatTagsChange(conversation.id, {
        suggested_chat_tag_id: outcome.suggestion.mainId,
        suggested_chat_sub_tag_id: outcome.suggestion.subId,
        suggested_tag_p: outcome.suggestion.p,
        suggested_tag_at: new Date().toISOString(),
      });
      return;
    }
    if (outcome.error) toast.error(ts(outcome.key));
    else toast(ts(outcome.key));
  }

  let suggestionSlot: ReactNode = null;
  if (chip && suggestedMain) {
    const percent = suggestionPercent(chip.p);
    const text = ts('chip', {
      tags: suggestionTagText(suggestedMain.name, suggestedSub?.name),
      percent,
    });
    suggestionSlot = (
      <span className={SUGGESTION_CHIP} title={text}>
        <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
        <button
          type="button"
          onClick={() => void applySuggestion(chip)}
          disabled={saving}
          className={cn(SUGGESTION_BUTTON, 'px-2 font-semibold')}
        >
          {ts('apply')}
        </button>
        <button
          type="button"
          onClick={() => void dismissSuggestion(chip)}
          disabled={saving}
          aria-label={ts('dismiss')}
          title={ts('dismiss')}
          className={cn(SUGGESTION_BUTTON, 'w-5')}
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      </span>
    );
  } else if (canAsk) {
    suggestionSlot = (
      <button
        type="button"
        onClick={() => void askForSuggestion()}
        disabled={asking}
        aria-busy={asking || undefined}
        className={cn(
          CHIP,
          'text-wa-text-secondary hover:bg-wa-row-hover border-transparent',
          asking && CHIP_BUSY
        )}
      >
        {asking ? (
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin"
          />
        ) : (
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">
          {asking ? ts('suggesting') : ts('suggest')}
        </span>
      </button>
    );
  }

  function pickMain(tag: ChatTagNode | null) {
    if (!tag) {
      if (shown.chat_tag_id !== null || shown.chat_sub_tag_id !== null) {
        void save({ chat_tag_id: null, chat_sub_tag_id: null }, false);
      }
      return;
    }
    if (tag.id === main?.id) {
      // Already this tag: keep its sub-tag, but offer one if none.
      if (!sub && tag.subs.length > 0 && !savingRef.current) {
        followUp.current = { forTag: tag.id, menuClosed: false, saved: true };
      }
      return;
    }
    void save(
      { chat_tag_id: tag.id, chat_sub_tag_id: null },
      tag.subs.length > 0
    );
  }

  function pickSub(tag: ChatTag | null) {
    if (!main || (tag?.id ?? null) === (sub?.id ?? null)) return;
    void save(
      { chat_tag_id: main.id, chat_sub_tag_id: tag?.id ?? null },
      false
    );
  }

  const subTitle = main?.sub_tag_title?.trim() || t('subTagDefault');

  // ── Who sees what ──────────────────────────────────────────────
  if (tree.mains.length === 0) {
    // Nothing set up yet: the people who can set it up get the way in.
    if (!isAdmin) return null;
    return (
      <Row label={t('rowLabel')}>
        <Link href={CHAT_TAGS_SETTINGS_HREF} className={cn(CHIP, CHIP_DASHED)}>
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('setUp')}</span>
        </Link>
      </Row>
    );
  }

  if (!canEdit) {
    // A viewer reads the tags and cannot change them.
    if (!main) return null;
    return (
      <Row label={t('rowLabel')}>
        <ChatTagPill
          main={main}
          sub={sub}
          size="md"
          title={
            sub
              ? `${t('chipTitle', { name: main.name })} · ${t('subChipTitle', { title: subTitle, name: sub.name })}`
              : t('chipTitle', { name: main.name })
          }
        />
      </Row>
    );
  }

  // A chosen sub-tag joins its main tag in one pill; an empty sub-tag
  // slot stays a separate dashed invitation.
  const joined = !!(main && sub);

  return (
    <Row label={t('rowLabel')} busy={saving}>
      <span
        className={cn(
          'inline-flex max-w-full min-w-0 items-center',
          !joined && 'gap-1.5'
        )}
      >
        <DropdownMenu
          open={mainOpen}
          onOpenChange={(open) => {
            if (open && savingRef.current) return;
            setMainOpen(open);
          }}
          onOpenChangeComplete={(open) => {
            if (open) return;
            followUp.current.menuClosed = true;
            maybeOpenSub();
          }}
        >
          <DropdownMenuTrigger
            aria-disabled={saving || undefined}
            title={main ? t('chipTitle', { name: main.name }) : t('addTag')}
            className={cn(
              CHIP,
              main ? CHIP_TINTED : CHIP_DASHED,
              joined && cn(CHIP_LEFT, 'min-w-0'),
              savingMain && CHIP_BUSY
            )}
            style={main ? chatTagMainStyle(main.color) : undefined}
          >
            {main ? (
              <>
                <PillDot color={main.color} size="md" />
                <span className={PILL_MAIN_TEXT}>{main.name}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t('addTag')}</span>
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="border-border bg-popover w-64"
          >
            <div className={MENU_HEADING}>{t('heading')}</div>
            <DropdownMenuItem
              onClick={() => pickMain(null)}
              className="text-popover-foreground text-sm"
            >
              <span
                aria-hidden="true"
                className="border-muted-foreground h-2 w-2 shrink-0 rounded-full border"
              />
              <span className="flex-1">{t('noTag')}</span>
              {!main && <Check className="ml-2 h-3 w-3" />}
            </DropdownMenuItem>
            {tree.mains.map((tag) => (
              <DropdownMenuItem
                key={tag.id}
                onClick={() => pickMain(tag)}
                className="text-popover-foreground text-sm"
              >
                <Dot color={tag.color} />
                <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                {tag.subs.length > 0 && (
                  <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                    {tag.sub_tag_title?.trim() ||
                      t('subCount', { count: tag.subs.length })}
                  </span>
                )}
                {tag.id === main?.id && <Check className="ml-2 h-3 w-3" />}
              </DropdownMenuItem>
            ))}
            {isAdmin && (
              <>
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  render={<Link href={CHAT_TAGS_SETTINGS_HREF} />}
                  className="text-muted-foreground text-sm"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('manage')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {main && main.subs.length > 0 && (
          <DropdownMenu
            open={subOpen}
            onOpenChange={(open) => {
              if (open && savingRef.current) return;
              setSubOpenFor(open ? main.id : null);
            }}
          >
            <DropdownMenuTrigger
              aria-disabled={saving || undefined}
              title={
                sub
                  ? t('subChipTitle', { title: subTitle, name: sub.name })
                  : t('addSub', { title: subTitle })
              }
              className={cn(
                CHIP,
                sub
                  ? cn(CHIP_TINTED, CHIP_RIGHT, 'max-w-[50%] shrink-0')
                  : CHIP_DASHED,
                saving && !savingMain && CHIP_BUSY
              )}
              style={sub ? chatTagSubStyle(main.color, sub.color) : undefined}
            >
              {sub ? (
                <>
                  <PillDot color={sub.color} size="md" />
                  <span className={PILL_SUB_TEXT}>{sub.name}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{subTitle}</span>
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover w-56"
            >
              <div className={MENU_HEADING}>{subTitle}</div>
              <DropdownMenuItem
                onClick={() => pickSub(null)}
                className="text-popover-foreground text-sm"
              >
                <span
                  aria-hidden="true"
                  className="border-muted-foreground h-2 w-2 shrink-0 rounded-full border"
                />
                <span className="flex-1">{t('subNone')}</span>
                {!sub && <Check className="ml-2 h-3 w-3" />}
              </DropdownMenuItem>
              {main.subs.map((tag) => (
                <DropdownMenuItem
                  key={tag.id}
                  onClick={() => pickSub(tag)}
                  className="text-popover-foreground text-sm"
                >
                  <Dot color={tag.color} />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  {tag.id === sub?.id && <Check className="ml-2 h-3 w-3" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
      {suggestionSlot}
    </Row>
  );
}

/** The row under the header's first, padded to line up with it. */
function Row({
  label,
  busy,
  children,
}: {
  label: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      className="border-wa-divider flex min-h-10 flex-wrap items-center gap-1.5 border-t px-2 py-1.5 sm:px-4"
    >
      {children}
    </div>
  );
}
