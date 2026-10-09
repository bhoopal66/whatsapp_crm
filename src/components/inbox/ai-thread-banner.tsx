'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  Hand,
  Undo2,
  Loader2,
  Send,
  Pencil,
  Trash2,
  X,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import {
  aiBannerState,
  bannerSnapshot,
  withOverride,
  type BannerOverride,
} from '@/lib/ai/banner-state';
import type { Conversation } from '@/types';

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  autoReplyOn: boolean;
  /** `ai_configs.auto_resume_minutes`; null = never. */
  autoResumeMinutes: number | null;
}
const statusCache = new Map<string, AiAccountStatus>();
const STATUS_OFF: AiAccountStatus = {
  autoReplyOn: false,
  autoResumeMinutes: null,
};

async function fetchAiAccountStatus(
  accountId: string
): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch('/api/ai/config', { cache: 'no-store' });
    if (!res.ok) return STATUS_OFF; // don't cache a transient failure
    const j = await res.json();
    const status: AiAccountStatus = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
      autoResumeMinutes:
        typeof j?.auto_resume_minutes === 'number'
          ? j.auto_resume_minutes
          : null,
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return STATUS_OFF; // don't cache
  }
}

/** The conversation fields the banner reads. */
export type AiBannerConversation = Pick<
  Conversation,
  | 'id'
  | 'assigned_agent_id'
  | 'ai_autoreply_disabled'
  | 'ai_handoff_summary'
  | 'ai_paused_reason'
  | 'ai_paused_at'
  | 'ai_pending_draft'
  | 'ai_pending_draft_at'
  | 'ai_last_outcome'
  | 'ai_last_outcome_detail'
  | 'ai_last_outcome_at'
>;

/** What a successful action changed on the row, for the parent to patch. */
export type AiBannerPatch = Partial<Omit<AiBannerConversation, 'id'>>;

// The row as each route leaves it. The realtime UPDATE reconciles the
// exact values (the 077 trigger, for one, re-pauses after a sent draft).
function takeOverPatch(userId: string | null | undefined): AiBannerPatch {
  return {
    ai_autoreply_disabled: true,
    ai_paused_reason: 'take_over',
    ai_paused_at: new Date().toISOString(),
    ...(userId ? { assigned_agent_id: userId } : {}),
  };
}
// Resume releases any assignment and clears the pause, the hand-off
// note and a held draft (POST /api/ai/autoreply).
const RESUME_PATCH: AiBannerPatch = {
  ai_autoreply_disabled: false,
  assigned_agent_id: undefined,
  ai_paused_reason: null,
  ai_paused_at: null,
  ai_handoff_summary: null,
  ai_pending_draft: null,
  ai_pending_draft_at: null,
};
const DRAFT_CLEARED: AiBannerPatch = {
  ai_pending_draft: null,
  ai_pending_draft_at: null,
};

type Action = 'toggle' | 'send' | 'sendEdited' | 'discard';

interface AiThreadBannerProps {
  conversation: AiBannerConversation;
  /** `created_at` of the newest loaded bot-generated message. */
  lastAiReplyAt: string | null;
  /** The newest loaded message is the customer's. */
  lastMessageFromCustomer: boolean;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful action so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: AiBannerPatch) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation (AI agent v2, migration 077). `aiBannerState()` picks
 * what it shows:
 *   - a held draft → the draft + [Send draft] [Edit] [Discard]
 *   - paused here → why (take over / agent reply / hand-off) + [Resume]
 *   - assigned → "AI is off while assigned" + [Resume AI]
 *   - active → "AI is replying" + [Take over], and a warning when its
 *     last dispatch left the customer unanswered
 * Renders nothing when the account has no auto-reply configured.
 */
export function AiThreadBanner({
  conversation: server,
  lastAiReplyAt,
  lastMessageFromCustomer,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations('Inbox.aiBanner');
  const { accountId } = useAuth();
  const conversationId = server.id;
  const [status, setStatus] = useState<AiAccountStatus | null>(null);
  // Every piece of local state remembers the chat (and, where it
  // matters, the server snapshot) it belongs to, and is ignored once
  // that changes — derived on render instead of reset in an effect.
  const [busy, setBusy] = useState<{ conv: string; action: Action } | null>(
    null
  );
  const [override, setOverride] =
    useState<BannerOverride<AiBannerPatch> | null>(null);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(
    null
  );
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const snapshot = bannerSnapshot(server);
  const conversation = withOverride(conversationId, server, override);
  const busyAction = busy?.conv === conversationId ? busy.action : null;
  // Which text the expand / edit state belongs to: a newer draft or
  // note starts collapsed and unedited.
  const textKey = `${conversationId}:${conversation.ai_pending_draft_at ?? ''}:${
    conversation.ai_pending_draft ?? conversation.ai_handoff_summary ?? ''
  }`;
  const editText = editing?.key === textKey ? editing.text : null;
  const expanded = expandedKey === textKey;

  const applied = useCallback(
    (patch: AiBannerPatch) => {
      setOverride({
        forConversation: conversationId,
        forSnapshot: snapshot,
        value: patch,
      });
      onChange?.(patch);
    },
    [conversationId, snapshot, onChange]
  );

  const setPaused = useCallback(
    async (paused: boolean, replyNow = false) => {
      setBusy({ conv: conversationId, action: 'toggle' });
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify(
            paused
              ? { paused: true, assign_to_me: true }
              : { paused: false, reply_now: replyNow }
          ),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(j?.error ?? t('updateError'));
          return;
        }
        applied(paused ? takeOverPatch(currentUserId) : RESUME_PATCH);
        toast.success(
          paused
            ? t('tookOver')
            : j?.replying
              ? t('resumedReplying')
              : t('resumed')
        );
      } catch {
        toast.error(t('networkError'));
      } finally {
        setBusy(null);
      }
    },
    [conversationId, currentUserId, applied, t]
  );

  const actOnDraft = useCallback(
    async (action: 'send' | 'discard', text?: string) => {
      setBusy({
        conv: conversationId,
        action: action === 'discard' ? 'discard' : text ? 'sendEdited' : 'send',
      });
      try {
        const res = await fetch(`/api/ai/pending-draft/${conversationId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(text ? { action, text } : { action }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(j?.error ?? t('draftError'));
          // 409: the draft is already gone (someone else acted on it).
          if (res.status === 409) applied(DRAFT_CLEARED);
          return;
        }
        setEditing(null);
        if (j?.cleared === false) {
          // A newer draft replaced this one meanwhile; realtime shows it.
          if (action === 'send') toast.success(t('draftSent'));
          toast.info(t('draftReplaced'));
          return;
        }
        applied(DRAFT_CLEARED);
        toast.success(action === 'send' ? t('draftSent') : t('draftDiscarded'));
      } catch {
        toast.error(t('networkError'));
      } finally {
        setBusy(null);
      }
    },
    [conversationId, applied, t]
  );

  // Account has no auto-reply → nothing to show. (Still loading → nothing.)
  const state = aiBannerState({
    autoReplyOn: !!status?.autoReplyOn,
    autoResumeMinutes: status?.autoResumeMinutes ?? null,
    conversation,
    lastAiReplyAt,
    lastMessageFromCustomer,
  });
  const disabled = busyAction !== null;

  switch (state.kind) {
    case 'hidden':
      return null;

    case 'draft':
      return (
        <Banner tone="primary" stacked>
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="text-wa-teal h-3.5 w-3.5 flex-shrink-0" />
            <span className="text-wa-text font-medium">{t('draftTitle')}</span>
          </div>
          {state.reason && (
            <ExpandableText
              text={t('draftReason', { reason: state.reason })}
              expanded={expanded}
              onToggle={() => setExpandedKey(expanded ? null : textKey)}
              moreLabel={t('showMore')}
              lessLabel={t('showLess')}
            />
          )}
          {editText === null ? (
            <blockquote className="border-wa-teal bg-wa-panel text-wa-text max-h-48 overflow-y-auto rounded-r border-l-2 px-2.5 py-1.5 break-words whitespace-pre-wrap">
              {state.draft}
            </blockquote>
          ) : (
            <textarea
              aria-label={t('editLabel')}
              value={editText}
              onChange={(e) =>
                setEditing({ key: textKey, text: e.target.value })
              }
              disabled={disabled}
              rows={4}
              autoFocus
              className="border-wa-divider bg-wa-panel text-wa-text focus-visible:border-wa-teal max-h-48 min-h-16 w-full resize-y rounded border px-2.5 py-1.5 text-xs outline-none disabled:opacity-60"
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {editText === null ? (
              <>
                <BannerButton
                  onClick={() => actOnDraft('discard')}
                  busy={busyAction === 'discard'}
                  disabled={disabled}
                  icon={Trash2}
                >
                  {t('discardDraft')}
                </BannerButton>
                <BannerButton
                  onClick={() =>
                    setEditing({ key: textKey, text: state.draft })
                  }
                  busy={false}
                  disabled={disabled}
                  icon={Pencil}
                >
                  {t('editDraft')}
                </BannerButton>
                <BannerButton
                  onClick={() => actOnDraft('send')}
                  busy={busyAction === 'send'}
                  disabled={disabled}
                  icon={Send}
                >
                  {t('sendDraft')}
                </BannerButton>
              </>
            ) : (
              <>
                <BannerButton
                  onClick={() => setEditing(null)}
                  busy={false}
                  disabled={disabled}
                  icon={X}
                >
                  {t('cancelEdit')}
                </BannerButton>
                <BannerButton
                  onClick={() => actOnDraft('send', editText.trim())}
                  busy={busyAction === 'sendEdited'}
                  disabled={disabled || !editText.trim()}
                  icon={Send}
                >
                  {t('sendEdited')}
                </BannerButton>
              </>
            )}
          </div>
        </Banner>
      );

    case 'paused':
      return (
        <Banner tone="muted">
          <div className="min-w-0 flex-1">
            <p className="text-wa-text font-medium">
              {state.reason === 'agent_reply'
                ? t('pausedAgentReply')
                : state.reason === 'handoff'
                  ? t('pausedHandoff')
                  : t('pausedTakeOver')}
            </p>
            {state.autoResume && (
              <p className="text-wa-text-secondary">
                {t(
                  state.autoResume.unit === 'hours'
                    ? 'resumesAfterHours'
                    : 'resumesAfterMinutes',
                  { count: state.autoResume.count }
                )}
              </p>
            )}
            {state.summary && (
              <ExpandableText
                text={state.summary}
                expanded={expanded}
                onToggle={() => setExpandedKey(expanded ? null : textKey)}
                moreLabel={t('showMore')}
                lessLabel={t('showLess')}
              />
            )}
          </div>
          <BannerButton
            onClick={() => setPaused(false, state.replyNow)}
            busy={busyAction === 'toggle'}
            disabled={disabled}
            icon={Undo2}
          >
            {state.replyNow ? t('resumeAndReply') : t('resume')}
          </BannerButton>
        </Banner>
      );

    case 'assigned':
      return (
        <Banner tone="muted">
          <p className="text-wa-text-secondary min-w-0 flex-1 truncate">
            {t('assignedText')}
          </p>
          <BannerButton
            onClick={() => setPaused(false)}
            busy={busyAction === 'toggle'}
            disabled={disabled}
            icon={Undo2}
          >
            {t('resume')}
          </BannerButton>
        </Banner>
      );

    case 'active':
      return (
        <Banner tone="primary">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Sparkles className="text-wa-teal h-3.5 w-3.5 flex-shrink-0" />
              <span className="text-wa-text truncate font-medium">
                {t('activeText')}
              </span>
            </div>
            {state.warning && (
              <div role="status" className="text-wa-warning mt-1 flex gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p>
                    {t('outcomeWarning', {
                      reason: t(`outcome.${state.warning.outcome}`),
                    })}
                  </p>
                  {state.warning.detail && (
                    <p className="text-wa-text-secondary break-words">
                      {t('outcomeDetail', { detail: state.warning.detail })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          <BannerButton
            onClick={() => setPaused(true)}
            busy={busyAction === 'toggle'}
            disabled={disabled}
            icon={Hand}
          >
            {t('takeOver')}
          </BannerButton>
        </Banner>
      );
  }
}

// A note longer than one line is truncated until expanded; expanded, it
// shows in full, line breaks included.
const LONG_TEXT = 90;

function ExpandableText({
  text,
  expanded,
  onToggle,
  moreLabel,
  lessLabel,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
  moreLabel: string;
  lessLabel: string;
}) {
  const long = text.length > LONG_TEXT || text.includes('\n');
  return (
    <div className="text-wa-text-secondary flex min-w-0 items-start gap-2">
      <p
        className={cn(
          'min-w-0 flex-1',
          expanded ? 'break-words whitespace-pre-wrap' : 'truncate'
        )}
        title={expanded ? undefined : text}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="text-wa-teal flex-shrink-0 font-medium hover:underline"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}

function Banner({
  tone,
  stacked,
  children,
}: {
  tone: 'primary' | 'muted';
  /** Column layout, for the held draft's text, block and buttons. */
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    // Solid, like the composer it sits on: a translucent bar let the
    // chat wallpaper's doodles show through the text.
    <div
      className={cn(
        'border-wa-divider bg-wa-panel-header flex gap-3 border-t px-3 py-2 text-xs sm:px-4',
        stacked ? 'flex-col gap-2' : 'items-center',
        tone === 'primary' && 'shadow-[inset_3px_0_0_var(--wa-teal)]'
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  disabled,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-wa-divider bg-wa-panel text-wa-teal hover:bg-wa-row-hover inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-3 py-1 font-medium transition-colors disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
