'use client';

// The in-call panel (module 015): a floating window for the call this
// person answered, bottom-right by default, that they can drag anywhere
// by its dark header, nudge with the arrow keys, double-click back home
// and minimise to a one-row pill (use-floating-window; the spot and the
// minimised state are remembered as `pbx:call-window`). Below `sm` it is
// a bottom sheet, and minimised a bar along the bottom. After hang-up it
// is the wrap-up (§7.3): two minutes, counted down, to add the outcome
// and a note, then it closes by itself, minimised or not, unless outcomes
// are mandatory and none is chosen (it stays, opens itself once if
// minimised, and the PBX cron rings a reminder). A reload re-opens
// it (CallProvider). Outcome and notes autosave to the call (PATCH, one
// save at a time, queued until the call's row is there: use-call-note);
// what could not be saved keeps the panel open on a person's Close, and
// is kept behind a message when the panel goes by itself. The optional
// call card goes to a team chat channel when the panel closes. Nothing
// here is ever sent to the customer.
//
// It sits at z-50, under the ringing card (z-[60]): an open or queued
// wrap-up must never cover Answer and Decline.

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  GripHorizontal,
  Grid3x3,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelsWithGuests, listChannels, shareCall } from '@/lib/chat';
import {
  OUTCOMES,
  canTransferToOwner,
  consentText,
  formatTimer,
  maskPhone,
  messageWhen,
  needsOutcome,
  newContactPhone,
  otherOwner,
  tryTimes,
  AUTO_SHARE_TRIES,
  wrapUpLeftMs,
  wrapUpPhase,
  type Outcome,
  type WrapUpPhase,
} from '@/lib/pbx/call-ui';
import {
  closeDecision,
  isUnsaved,
  keepMine,
  keepTheirs,
  onNotes,
  onOutcome,
} from '@/lib/pbx/call-note';
import { CALL_WINDOW_DEFAULT } from '@/lib/pbx/call-window';
import { customerHref } from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { useCalls } from './call-provider';
import { ContactCasesMini } from './call-cases';
import { FollowUpReminder } from './call-follow-up';
import { CallHistoryList, useCallHistory } from './call-history';
import { OpenTasks } from './call-tasks';
import {
  CandidatePicker,
  FactsIncomplete,
  useCallFacts,
  useNow,
  type CallFacts,
} from './incoming-call-card';
import { useNewCallerForm } from './new-caller-form';
import { useCallNote } from './use-call-note';
import { useFloatingWindow } from './use-floating-window';

interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  contact_id: string | null;
  disposition: Outcome | null;
  notes: string | null;
  answered_at: string | null;
  talk_seconds: number | null;
  recording_state: string;
}

/**
 * One tab of the window's body. The list is built from an array in
 * Panel, so a new tab (History) is one more entry.
 */
export interface CallWindowTab {
  id: string;
  label: string;
  panel: ReactNode;
}

export function InCallPanel() {
  const calls = useCalls();
  const panel = calls?.panel ?? null;
  return panel && calls?.me ? <Panel key={panel.key} /> : null;
}

function Panel() {
  const calls = useCalls()!;
  const p = calls.panel!;
  const me = calls.me!;
  const t = useTranslations('PbxCall');
  const { accountId } = useAuth();
  const sb = useMemo(() => createClient(), []);
  const [row, setRow] = useState<CallRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const { note, draft, saved, leaving } = useCallNote(accountId, p, calls);
  const { outcome, notes } = draft;
  // A person's Close found something unsaved.
  const [stayed, setStayed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [keypad, setKeypad] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [share, setShare] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [blocked, setBlocked] = useState(false);
  // For the panel's lifetime only: each call opens on Notes.
  const [tab, setTab] = useState('notes');
  const canCreateContact = useCan('send-messages');
  const { form: newCallerForm, open: openNewCaller } = useNewCallerForm();
  const { attach, handleProps, minimized, setMinimized, mobile } =
    useFloatingWindow({
      storageKey: 'pbx:call-window',
      defaultAnchor: CALL_WINDOW_DEFAULT,
      label: t('moveWindow'),
      roleDescription: t('draggable'),
    });
  const ended = p.endedAt !== null;
  // Ticks after hang-up too: the wrap-up's countdown.
  const now = useNow(true);
  const wrapLeft = p.endedAt === null ? null : wrapUpLeftMs(p.endedAt, now);
  const pickedId = calls.picks[p.key];
  const { facts, retry: retryFacts } = useCallFacts(
    row?.contact_id ?? p.contactId ?? pickedId ?? null,
    {
      connectionId: p.connectionId,
      pbxCallId: p.pbxCallId,
    },
    ended
  );
  const ref = { pbxCallId: p.pbxCallId, remoteNumber: p.remoteNumber };
  const owner = otherOwner(facts?.ownerId, calls.userId);
  const [ownerExt, setOwnerExt] = useState<{
    owner: string;
    extension: string | null;
  } | null>(null);

  // The owner's extension on this PBX, as the transfer route looks it up.
  useEffect(() => {
    if (!owner) return;
    let live = true;
    void sb
      .from('pbx_extensions')
      .select('extension')
      .eq('connection_id', me.connectionId)
      .eq('user_id', owner)
      .maybeSingle()
      .then(({ data }) => {
        if (live)
          setOwnerExt({
            owner,
            extension:
              (data as { extension: string } | null)?.extension ?? null,
          });
      });
    return () => {
      live = false;
    };
  }, [sb, owner, me.connectionId]);
  const toOwner = canTransferToOwner(
    owner,
    calls.userId,
    ownerExt?.owner === owner ? ownerExt.extension : null,
    me.extension
  );

  const load = useCallback(async () => {
    const { data, error } = await sb
      .from('calls')
      .select(
        'id, direction, contact_id, disposition, notes, answered_at, talk_seconds, recording_state'
      )
      .eq('connection_id', p.connectionId)
      .eq('pbx_call_id', p.pbxCallId)
      .maybeSingle();
    setLoadFailed(Boolean(error));
    const r = data as CallRow | null;
    if (!r) return;
    setRow(r);
    note.row(r.id, r);
  }, [sb, p.connectionId, p.pbxCallId, note]);

  const hasRow = row !== null;
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 4000);
    // After hang-up, long enough for the final talk time to land; a row
    // that has not come is asked for as long as the panel is open.
    const stop =
      ended && hasRow ? setTimeout(() => clearInterval(id), 12_000) : null;
    return () => {
      clearTimeout(first);
      clearInterval(id);
      if (stop) clearTimeout(stop);
    };
  }, [load, ended, hasRow]);

  useEffect(() => {
    if (!accountId || !calls.userId) return;
    void listChannels(sb, accountId, calls.userId)
      .then(async (cs) => {
        const open = cs.filter(
          (c) =>
            (c.kind === 'team' ||
              c.kind === 'private' ||
              c.kind === 'deal_room') &&
            !c.archivedAt &&
            c.membership &&
            c.name
        );
        // A call card is refused where a bank guest reads (a deal room's
        // Team notes excepted); a failed lookup leaves them offered.
        const guests = await channelsWithGuests(
          sb,
          open.filter((c) => c.kind !== 'deal_room').map((c) => c.id)
        ).catch(() => new Set<string>());
        setChannels(
          open
            .filter((c) => c.kind === 'deal_room' || !guests.has(c.id))
            .map((c) => ({ id: c.id, name: c.name as string }))
        );
      })
      .catch(() => setChannels([]));
  }, [sb, accountId, calls.userId]);

  // A customer picked on the card is linked once the call row exists.
  useEffect(() => {
    if (!row || row.contact_id || !pickedId) return;
    void fetch(`/api/pbx/calls/${row.id}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: pickedId }),
    }).then((r) => {
      if (r.ok) {
        calls.pick(p.key, null);
        void load();
      }
    });
  }, [row, pickedId, calls, p.key, load]);

  const act = async (
    sp: () => Promise<void>,
    action: Parameters<typeof calls.control>[1]
  ) => {
    if (calls.softphone) {
      await sp().catch((e) =>
        toast.error(
          t('actionFailed', {
            message: e instanceof Error ? e.message : String(e),
          })
        )
      );
      return true;
    }
    return calls.control(p.pbxCallId, action);
  };

  const startedAt = row?.answered_at ? Date.parse(row.answered_at) : p.seenAt;
  const talkMs =
    ended && row?.talk_seconds != null
      ? row.talk_seconds * 1000
      : (p.endedAt ?? now) - startedAt;
  const recording =
    calls.settings.announcementRequired &&
    !['held', 'erased'].includes(row?.recording_state ?? '');

  // `auto`: the wrap-up's own close. A ticked call card that will not
  // post is retried, then the panel closes anyway with the error showing
  // (the outcome and notes are on the call, or kept by `leaving`); a
  // person's Close stays open on failure, to try again.
  const close = async (auto = false) => {
    if (needsOutcome(calls.settings.mandatoryDisposition, outcome)) {
      setBlocked(true);
      return;
    }
    await note.save();
    const decision = closeDecision(note.get(), auto);
    setStayed(decision === 'stay');
    if (decision === 'stay') return;
    // A card (103): its details reach only colleagues who may see the
    // call, so the post's own text names nothing of the customer.
    const callId = row?.id;
    if (share && channelId) {
      const shared =
        !!callId &&
        (await tryTimes(auto ? AUTO_SHARE_TRIES : 1, () =>
          shareCall(sb, { channelId, callId, body: t('shareCardBody') })
        ));
      if (!shared) {
        toast.error(
          t(auto && decision === 'close' ? 'shareFailedClosed' : 'shareFailed')
        );
        if (!auto) return;
      }
    }
    if (decision === 'keep') leaving('tried');
    calls.closePanel(p.key);
  };
  // The way out of a call that takes no note any more (erased, or no
  // longer this person's to write on). Posts no call card: that may be
  // refused too.
  const closeUnsaved = () => {
    if (needsOutcome(calls.settings.mandatoryDisposition, outcome)) {
      setBlocked(true);
      return;
    }
    leaving('discard');
    calls.closePanel(p.key);
  };

  // Whether an outcome is chosen decides if this wrap-up, pushed aside
  // by a live call, is still owed when it comes back (selectPanel).
  const { noteOutcome } = calls;
  useEffect(() => {
    noteOutcome(p.key, outcome !== null);
  }, [noteOutcome, p.key, outcome]);

  // The wrap-up's phase, settled during render (it only moves forward):
  // `done` closes as Close would (pending notes saved, a ticked call
  // card shared), once; `held` waits for an outcome and Close.
  const [phase, setPhase] = useState<WrapUpPhase>('counting');
  const nextPhase =
    p.endedAt === null
      ? phase
      : wrapUpPhase(
          phase,
          p.endedAt,
          now,
          calls.settings.mandatoryDisposition,
          outcome
        );
  if (nextPhase !== phase) setPhase(nextPhase);
  const autoClosed = useRef(false);
  const autoClose = useEffectEvent(() => void close(true));
  useEffect(() => {
    if (phase !== 'done' || autoClosed.current) return;
    autoClosed.current = true;
    autoClose();
  }, [phase]);

  // Outcomes mandatory and the two minutes up with none chosen: a
  // minimised window opens itself, once, on Notes.
  const expandedForOutcome = useRef(false);
  const expandForOutcome = useEffectEvent(() => {
    if (!minimized) return;
    setTab('notes');
    setMinimized(false);
  });
  useEffect(() => {
    if (phase !== 'held' || expandedForOutcome.current) return;
    expandedForOutcome.current = true;
    expandForOutcome();
  }, [phase]);

  const toggleMute = async () =>
    (await act(
      () => calls.softphone!.mute(ref, !muted),
      muted ? 'unmute' : 'mute'
    )) && setMuted(!muted);
  const toggleHold = async () =>
    (await act(
      () => calls.softphone!.hold(ref, !held),
      held ? 'unhold' : 'hold'
    )) && setHeld(!held);
  const hangUp = () => void act(() => calls.softphone!.hangup(ref), 'hangup');

  const owed = needsOutcome(calls.settings.mandatoryDisposition, outcome);
  const name =
    [facts?.name, facts?.company].filter(Boolean).join(' · ') ||
    t('unknownCaller');
  const masked = maskPhone(p.remoteNumber ?? facts?.phone);
  const contactId = row?.contact_id ?? p.contactId ?? pickedId ?? null;
  // A contact the person cannot see gets no history, tasks or reminder,
  // as it gets no links (CustomerTab).
  const visibleId = facts && !facts.hidden ? contactId : null;
  const history = useCallHistory(visibleId, p.pbxCallId);
  // Whole seconds up: 0:00 only once the time is up.
  const wrapLabel =
    wrapLeft !== null && phase === 'counting'
      ? formatTimer(Math.ceil(wrapLeft / 1000) * 1000)
      : null;

  const choice =
    'border-border hover:bg-muted rounded-md border px-3 py-1 text-sm font-medium';
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('noteCopied'));
    } catch {
      toast.error(t('noteCopyFailed'));
    }
  };
  // Why the outcome or note is not saved; shown on every tab.
  const unsaved = !isUnsaved(draft)
    ? null
    : draft.failed === 'refused'
      ? t('unsavedRefused')
      : draft.failed === 'lost'
        ? t('unsavedLost')
        : !stayed
          ? null
          : draft.conflict
            ? t('unsavedConflict')
            : row
              ? t('unsavedLost')
              : t('unsavedNoCall');
  const notesPanel = (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={t('outcome')}>
        <p className="mb-2 text-sm font-medium">{t('outcome')}</p>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={outcome === o}
              onClick={() => {
                const next = outcome === o ? null : o;
                setBlocked(false);
                setStayed(false);
                note.edit((d) => onOutcome(d, next), 'now');
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                outcome === o
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-muted'
              )}
            >
              {t(`outcomes.${o}`)}
            </button>
          ))}
        </div>
        {blocked && (
          <p className="text-destructive mt-2 text-xs">
            {t('outcomeRequired')}
          </p>
        )}
      </div>
      <label className="block">
        <span className="flex justify-between text-sm font-medium">
          {t('notes')}
          <span className="text-muted-foreground text-xs font-normal">
            {draft.saving
              ? t('saving')
              : draft.failed || draft.conflict
                ? t('notSaved')
                : isUnsaved(draft)
                  ? row
                    ? ''
                    : t('noteQueued')
                  : saved
                    ? t('saved')
                    : ''}
          </span>
        </span>
        <textarea
          value={notes}
          maxLength={4000}
          onChange={(e) => {
            const text = e.target.value;
            setStayed(false);
            note.edit((d) => onNotes(d, text));
          }}
          placeholder={t('notesPlaceholder')}
          className="border-input bg-card dark:bg-input/30 mt-1 min-h-20 w-full rounded-lg border p-2 text-sm"
        />
      </label>
      {loadFailed && !row && (
        <p role="alert" className="text-destructive text-xs">
          {t('noteLoadFailed')}{' '}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => void load()}
          >
            {t('retry')}
          </button>
        </p>
      )}
      {draft.conflict && (
        <div
          role="alert"
          className="border-warning/40 bg-warning-soft space-y-2 rounded-lg border p-3 text-sm"
        >
          <p className="font-medium">{t('noteConflict')}</p>
          {(
            [
              ['noteMine', notes],
              ['noteTheirs', draft.conflict.theirs ?? ''],
            ] as const
          ).map(([label, text]) => (
            <div key={label}>
              <p className="text-muted-foreground flex justify-between text-xs">
                {t(label)}
                {text && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void copy(text)}
                  >
                    {t('noteCopy')}
                  </button>
                )}
              </p>
              <p
                dir="auto"
                className="max-h-24 overflow-y-auto break-words whitespace-pre-wrap"
              >
                {text || t('noteEmpty')}
              </p>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              className={choice}
              onClick={() => note.edit(keepMine, 'now')}
            >
              {t('noteKeepMine')}
            </button>
            <button
              type="button"
              className={choice}
              onClick={() => note.edit(keepTheirs, 'now')}
            >
              {t('noteKeepTheirs')}
            </button>
          </div>
        </div>
      )}
      <FollowUpReminder
        contactId={visibleId}
        conversationId={facts?.conversationId ?? null}
        customerName={facts?.name ?? facts?.company ?? null}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          id="pbx-share"
          type="checkbox"
          checked={share}
          disabled={!channels.length}
          onChange={(e) => setShare(e.target.checked)}
        />
        <label htmlFor="pbx-share">{t('shareCard')}</label>
        {channels.length ? (
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="border-input bg-card dark:bg-input/30 rounded-md border px-2 py-1"
          >
            <option value="">{t('chooseChannel')}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-muted-foreground text-xs">
            {t('noChannels')}
          </span>
        )}
      </div>
    </div>
  );

  const tabs: CallWindowTab[] = [
    { id: 'notes', label: t('tabNotes'), panel: notesPanel },
    {
      id: 'customer',
      label: t('tabCustomer'),
      panel: (
        <CustomerTab
          facts={facts}
          onRetryFacts={retryFacts}
          contactId={contactId}
          now={now}
          onCreate={
            canCreateContact
              ? () =>
                  openNewCaller({
                    key: p.key,
                    connectionId: p.connectionId,
                    pbxCallId: p.pbxCallId,
                    phone: newContactPhone(p.remoteNumber),
                  })
              : null
          }
        />
      ),
    },
    ...(visibleId
      ? [
          {
            id: 'history',
            label: history.calls?.length
              ? `${t('tabHistory')} · ${history.calls.length}`
              : t('tabHistory'),
            panel: <CallHistoryList contactId={visibleId} history={history} />,
          },
        ]
      : []),
  ];
  const current = tabs.find((x) => x.id === tab) ?? tabs[0];
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(current);
    const n = tabs.length;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setTab(tabs[next].id);
    document.getElementById(`pbx-call-tab-${tabs[next].id}`)?.focus();
  };

  const control =
    'flex w-14 flex-col items-center gap-1 text-xs text-white/80 disabled:opacity-40';
  const disc = (on: boolean) =>
    cn(
      'flex size-11 items-center justify-center rounded-full transition-colors',
      on ? 'bg-white text-[#0f1b2d]' : 'bg-white/10 hover:bg-white/20'
    );
  const grip = !mobile && (
    <GripHorizontal aria-hidden className="size-4 shrink-0 text-white/45" />
  );
  const handleRing =
    'outline-none select-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-inset';

  return (
    <>
      {newCallerForm}
      <aside
        ref={attach}
        // The ringing card keeps clear of this (incoming-call-card.tsx).
        data-call-window
        aria-label={t('onCall', { extension: me.extension, mode: '' })}
        // Placed by useFloatingWindow (left/top); below `sm` a bottom
        // sheet, or minimised a bar, pinned by these classes instead.
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden shadow-2xl',
          minimized
            ? 'border border-white/10 bg-[#0f1b2d] text-white'
            : 'bg-card text-card-foreground border',
          mobile
            ? cn(
                // Above the phone's bottom tab bar (mobile-tab-bar.tsx),
                // which is there below `lg`; this is the `sm` layout.
                'inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] w-full',
                !minimized && 'max-h-[85dvh] rounded-t-2xl'
              )
            : cn(
                'max-w-[calc(100vw-24px)]',
                minimized
                  ? 'w-[320px] rounded-full'
                  : 'max-h-[calc(100dvh-24px)] w-[400px] rounded-2xl'
              )
        )}
      >
        {minimized && (
          <div
            {...handleProps}
            className={cn(
              'flex h-12 items-center gap-2 ps-3 pe-1.5',
              handleRing
            )}
          >
            {grip}
            <span
              aria-hidden
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                ended
                  ? 'bg-slate-400'
                  : held
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {name}
            </span>
            {!ended ? (
              <>
                <span className="text-sm tabular-nums">
                  {formatTimer(talkMs)}
                </span>
                <button
                  type="button"
                  aria-pressed={muted}
                  aria-label={muted ? t('unmute') : t('mute')}
                  title={muted ? t('unmute') : t('mute')}
                  onClick={() => void toggleMute()}
                  className={cn(disc(muted), 'size-8')}
                >
                  {muted ? (
                    <MicOff className="size-4" />
                  ) : (
                    <Mic className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('hangUp')}
                  title={t('hangUp')}
                  onClick={hangUp}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-red-600 hover:bg-red-500"
                >
                  <Phone className="size-4 rotate-[135deg]" />
                </button>
              </>
            ) : (
              <>
                <span
                  role="status"
                  className={cn(
                    'shrink-0 text-xs tabular-nums',
                    owed && wrapLabel === null
                      ? 'text-amber-200'
                      : 'text-white/75'
                  )}
                >
                  {wrapLabel !== null
                    ? t('wrapUpShort', { left: wrapLabel })
                    : owed
                      ? t('addOutcome')
                      : t('callEnded')}
                </span>
              </>
            )}
            <button
              type="button"
              aria-label={t('expand')}
              title={t('expand')}
              onClick={() => setMinimized(false)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-white/15"
            >
              <Maximize2 className="size-4" />
            </button>
          </div>
        )}
        {/* Kept mounted while minimised (hidden, not unmounted) so the
            reminder, notes and tab reads survive Minimise / Expand. */}
        <div hidden={minimized} className="flex min-h-0 flex-1 flex-col">
          <div
            {...handleProps}
            className={cn('shrink-0 bg-[#0f1b2d] p-4 text-white', handleRing)}
          >
            <div className="flex items-center gap-2 text-xs text-white/70">
              <span className="min-w-0 flex-1 truncate">
                {ended
                  ? t('wrapUpLine', { extension: me.extension })
                  : t('onCall', {
                      extension: me.extension,
                      mode: calls.softphone ? t('modeBrowser') : t('modeDesk'),
                    })}
              </span>
              {recording && !ended && (
                <span className="shrink-0 rounded-full bg-red-600 px-2 py-0.5 font-medium text-white">
                  ● {t('recording')}
                </span>
              )}
              {grip}
              <button
                type="button"
                aria-label={t('minimize')}
                title={t('minimize')}
                onClick={() => setMinimized(true)}
                className="-my-1 -me-1 flex size-7 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/15"
              >
                <Minus className="size-4" />
              </button>
            </div>
            <p className="mt-2 truncate text-lg font-semibold">{name}</p>
            <p className="flex items-center gap-1.5 text-sm text-white/70">
              {p.inbound ? (
                <PhoneIncoming aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <PhoneOutgoing aria-hidden className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {[
                  t(p.inbound ? 'directions.inbound' : 'directions.outbound'),
                  masked,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {ended ? `${t('callEnded')} · ` : ''}
              {formatTimer(talkMs)}
            </p>
            {calls.settings.announcementRequired && (
              <p className="mt-1 text-xs text-white/70">{t('noticePlayed')}</p>
            )}
            {wrapLeft !== null && (phase === 'counting' || owed) && (
              <p
                role="status"
                className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-sm tabular-nums"
              >
                {wrapLabel !== null
                  ? t('wrapUp', { left: wrapLabel })
                  : t('wrapUpOverdue')}
              </p>
            )}
            {!row?.contact_id && !p.contactId && pickedId === undefined && (
              <CandidatePickerFor callKey={p.key} />
            )}
            {!ended && (
              <>
                <div className="mt-4 flex items-start justify-center gap-1">
                  <button
                    type="button"
                    aria-pressed={muted}
                    className={control}
                    onClick={() => void toggleMute()}
                  >
                    <span className={disc(muted)}>
                      {muted ? (
                        <MicOff className="size-5" />
                      ) : (
                        <Mic className="size-5" />
                      )}
                    </span>
                    {muted ? t('unmute') : t('mute')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={held}
                    className={control}
                    onClick={() => void toggleHold()}
                  >
                    <span className={disc(held)}>
                      {held ? (
                        <Play className="size-5" />
                      ) : (
                        <Pause className="size-5" />
                      )}
                    </span>
                    {held ? t('resume') : t('hold')}
                  </button>
                  <button
                    type="button"
                    aria-expanded={transfer !== null}
                    className={control}
                    onClick={() => setTransfer(transfer === null ? '' : null)}
                  >
                    <span className={disc(transfer !== null)}>
                      <ArrowRightLeft className="size-5" />
                    </span>
                    {t('transfer')}
                  </button>
                  {calls.softphone && (
                    <button
                      type="button"
                      aria-expanded={keypad}
                      className={control}
                      onClick={() => setKeypad(!keypad)}
                    >
                      <span className={disc(keypad)}>
                        <Grid3x3 className="size-5" />
                      </span>
                      {t('keypad')}
                    </button>
                  )}
                  <button type="button" className={control} onClick={hangUp}>
                    <span className="flex size-11 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500">
                      <Phone className="size-5 rotate-[135deg]" />
                    </span>
                    {t('hangUp')}
                  </button>
                </div>
                {transfer !== null && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <input
                      value={transfer}
                      onChange={(e) => setTransfer(e.target.value)}
                      placeholder={t('transferNumber')}
                      aria-label={t('transferNumber')}
                      className="h-9 min-w-0 flex-1 rounded-lg bg-white/10 px-3 text-sm placeholder:text-white/55"
                    />
                    <button
                      type="button"
                      disabled={!transfer.trim()}
                      className="h-9 rounded-lg bg-white/15 px-3 text-sm disabled:opacity-40"
                      onClick={async () =>
                        (await calls.control(p.pbxCallId, 'transfer', {
                          number: transfer.trim(),
                        })) && toast.success(t('transferred'))
                      }
                    >
                      {t('transferTo')}
                    </button>
                    {toOwner && (
                      <button
                        type="button"
                        className="h-9 rounded-lg bg-white/15 px-3 text-sm"
                        onClick={async () =>
                          (await calls.control(p.pbxCallId, 'transfer', {
                            toOwner: true,
                          })) && toast.success(t('transferred'))
                        }
                      >
                        {t('transferToOwner')}
                      </button>
                    )}
                  </div>
                )}
                {keypad && calls.softphone && (
                  <div className="mx-auto mt-3 grid w-48 grid-cols-3 gap-2">
                    {[...'123456789*0#'].map((d) => (
                      <button
                        key={d}
                        type="button"
                        className="h-10 rounded-lg bg-white/10 text-lg"
                        onClick={() =>
                          void calls.softphone?.dtmf(ref, d).catch((e) =>
                            toast.error(
                              t('actionFailed', {
                                message:
                                  e instanceof Error ? e.message : String(e),
                              })
                            )
                          )
                        }
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div
            role="tablist"
            aria-label={t('tabsLabel')}
            onKeyDown={onTabKey}
            className="flex shrink-0 gap-1 border-b px-3"
          >
            {tabs.map((x) => (
              <button
                key={x.id}
                id={`pbx-call-tab-${x.id}`}
                type="button"
                role="tab"
                aria-selected={x === current}
                aria-controls={`pbx-call-panel-${x.id}`}
                tabIndex={x === current ? 0 : -1}
                onClick={() => setTab(x.id)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  x === current
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          {tabs.map((x) => (
            <div
              key={x.id}
              id={`pbx-call-panel-${x.id}`}
              role="tabpanel"
              aria-labelledby={`pbx-call-tab-${x.id}`}
              hidden={x !== current}
              // One height for every tab on desktop, so the window's
              // top (and the tab bar) stays put on a switch; it still
              // shrinks inside the window's max-height on a short screen.
              className="min-h-0 flex-1 overflow-y-auto p-4 sm:h-[400px] sm:flex-initial"
            >
              {x.panel}
            </div>
          ))}
          {unsaved && (
            <div
              role="alert"
              className="text-destructive bg-destructive-soft shrink-0 space-y-2 border-t p-3 text-sm"
            >
              <p>{unsaved}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={draft.saving}
                  className={choice}
                  onClick={() => {
                    if (!row) void load();
                    if (draft.conflict) setTab('notes');
                    void note.save();
                  }}
                >
                  {t('retry')}
                </button>
                {stayed && (ended || calls.closable) && (
                  <button
                    type="button"
                    className={choice}
                    onClick={closeUnsaved}
                  >
                    {t('closeUnsaved')}
                  </button>
                )}
              </div>
            </div>
          )}
          {/* A live call has no Close, unless its hang-up may be lost. */}
          {(ended || calls.closable) && (
            <div className="shrink-0 border-t p-3">
              <button
                type="button"
                onClick={() => void close()}
                className="bg-muted hover:bg-muted/80 h-10 w-full rounded-lg text-sm font-medium"
              >
                {t('close')}
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/** The Customer tab: what useCallFacts knows, and where to go next. */
function CustomerTab({
  facts,
  onRetryFacts,
  contactId,
  onCreate,
  now,
}: {
  facts: CallFacts | null;
  onRetryFacts: () => void;
  contactId: string | null;
  /** Create contact for an unknown caller; null without send-messages. */
  onCreate: (() => void) | null;
  now: number;
}) {
  const calls = useCalls()!;
  const t = useTranslations('PbxCall');
  const ownedBy = otherOwner(facts?.ownerId, calls.userId);
  // "None" only when it was read.
  const none = facts?.incomplete ? '—' : t('none');
  const owner = facts?.ownerId
    ? facts.ownerId === calls.userId
      ? t('you', { name: calls.names[facts.ownerId] ?? '' })
      : (calls.names[facts.ownerId] ?? facts.ownerName ?? '—')
    : t('noOwner');
  const fact = (label: string, value: string) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  const link =
    'border-border hover:bg-muted inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium';

  if (!contactId)
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t('noCustomerYet')}</p>
        {onCreate && (
          <button type="button" onClick={onCreate} className={link}>
            <UserRound className="size-4" />
            {t('createContact')}
          </button>
        )}
      </div>
    );

  return (
    <div className="space-y-3 text-sm">
      {ownedBy && (
        <p className="bg-info-soft text-info rounded-lg px-3 py-2 text-xs font-medium">
          {t('ownedBy', {
            name: calls.names[ownedBy] ?? facts?.ownerName ?? '—',
          })}
        </p>
      )}
      {facts && (
        <dl className="bg-card-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-xs">
          {fact(t('owner'), owner)}
          {!facts.hidden && fact(t('openDeal'), facts.deal ?? none)}
          {!facts.hidden &&
            fact(
              t('lastWhatsApp'),
              facts.last
                ? `${messageWhen(facts.last.at, now)} — “${facts.last.text}”`
                : none
            )}
          {fact(
            t('consent'),
            consentText(facts, {
              callsOk: t('callsOk'),
              doNotContact: t('doNotContact'),
              optedOut: t('optedOut'),
              unknown: t('consentUnknown'),
              marketingOn: t('marketingOn'),
              marketingOff: t('marketingOff'),
            })
          )}
          {facts.incomplete && <FactsIncomplete onRetry={onRetryFacts} />}
          {facts.hidden && !facts.incomplete && (
            <p className="text-muted-foreground col-span-2 mt-1">
              {t('detailsHidden')}
            </p>
          )}
        </dl>
      )}
      {/* A contact outside the person's view gets no links, as on the card. */}
      {facts && !facts.hidden && (
        <div className="flex flex-wrap gap-2">
          <Link
            href={customerHref({
              contactId,
              conversationId: facts.conversationId,
            })}
            className={link}
          >
            <UserRound className="size-4" />
            {t('customerPage')}
          </Link>
          {facts.conversationId && (
            <Link href={`/inbox?c=${facts.conversationId}`} className={link}>
              <MessageCircle className="size-4" />
              {t('whatsAppChat')}
            </Link>
          )}
        </div>
      )}
      {facts && !facts.hidden && (
        <>
          <OpenTasks contactId={contactId} />
          <ContactCasesMini contactId={contactId} />
        </>
      )}
    </div>
  );
}

function CandidatePickerFor({ callKey }: { callKey: string }) {
  const calls = useCalls()!;
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const [connectionId, ...rest] = callKey.split(':');
    void createClient()
      .from('calls')
      .select('meta')
      .eq('connection_id', connectionId)
      .eq('pbx_call_id', rest.join(':'))
      .maybeSingle()
      .then(({ data }) => {
        const c = (data as { meta?: { contact_candidates?: unknown } } | null)
          ?.meta?.contact_candidates;
        setIds(
          Array.isArray(c)
            ? c.filter((x): x is string => typeof x === 'string')
            : []
        );
      });
  }, [callKey]);
  return ids.length > 1 ? (
    <CandidatePicker
      ids={ids}
      value={null}
      onPick={(id) => calls.pick(callKey, id)}
    />
  ) : null;
}
