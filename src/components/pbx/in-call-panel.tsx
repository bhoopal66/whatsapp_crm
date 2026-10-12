'use client';

// The in-call panel (module 015): docked right (a full-screen sheet on
// mobile) for the call this person answered, and kept after hang-up
// until closed. Outcome and notes autosave to the call (PATCH, one save
// at a time); the optional call card goes to a team chat channel when
// the panel closes. Nothing here is ever sent to the customer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Grid3x3,
  Mic,
  MicOff,
  Pause,
  Phone,
  Play,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { listChannels, postMessage } from '@/lib/chat';
import {
  OUTCOMES,
  callCardText,
  formatTimer,
  needsOutcome,
  type Outcome,
} from '@/lib/pbx/call-ui';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { useCalls } from './call-provider';
import { CandidatePicker, useCallFacts, useNow } from './incoming-call-card';

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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState('');
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'failed'>(
    'idle'
  );
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [keypad, setKeypad] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [share, setShare] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [blocked, setBlocked] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);
  const ended = p.endedAt !== null;
  const now = useNow(!ended);
  const facts = useCallFacts(row?.contact_id ?? p.contactId);
  const ref = { pbxCallId: p.pbxCallId, remoteNumber: p.remoteNumber };

  const load = useCallback(async () => {
    const { data } = await sb
      .from('calls')
      .select(
        'id, direction, contact_id, disposition, notes, answered_at, talk_seconds, recording_state'
      )
      .eq('connection_id', p.connectionId)
      .eq('pbx_call_id', p.pbxCallId)
      .maybeSingle();
    const r = data as CallRow | null;
    if (!r) return;
    setRow(r);
    if (!loaded.current) {
      loaded.current = true;
      setOutcome((o) => o ?? r.disposition);
      setNotes((n) => n || (r.notes ?? ''));
    }
  }, [sb, p.connectionId, p.pbxCallId]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 4000);
    // After hang-up, long enough for the final talk time to land.
    const stop = ended ? setTimeout(() => clearInterval(id), 12_000) : null;
    return () => {
      clearTimeout(first);
      clearInterval(id);
      if (stop) clearTimeout(stop);
    };
  }, [load, ended]);

  useEffect(() => {
    if (!accountId || !calls.userId) return;
    void listChannels(sb, accountId, calls.userId)
      .then((cs) =>
        setChannels(
          cs
            .filter(
              (c) =>
                (c.kind === 'team' || c.kind === 'private') &&
                c.membership &&
                c.name
            )
            .map((c) => ({ id: c.id, name: c.name as string }))
        )
      )
      .catch(() => setChannels([]));
  }, [sb, accountId, calls.userId]);

  // A customer picked on the card is linked once the call row exists.
  const pickedId = calls.picks[p.key];
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

  const patch = useCallback(
    (body: object) => {
      if (!row) return Promise.resolve(false);
      setSave('saving');
      const run = chain.current.then(async () => {
        const r = await fetch(`/api/pbx/calls/${row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null);
        setSave(r?.ok ? 'saved' : 'failed');
        return Boolean(r?.ok);
      });
      chain.current = run;
      return run;
    },
    [row]
  );

  const onNotes = (v: string) => {
    setNotes(v);
    setSave('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void patch({ notes: v }), 800);
  };

  const act = async (
    sp: () => Promise<void>,
    action: Parameters<typeof calls.control>[1]
  ) => {
    if (calls.softphone) {
      await sp().catch((e) => toast.error(String(e)));
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
  const name = facts?.name || facts?.company || null;

  const close = async () => {
    if (needsOutcome(calls.settings.mandatoryDisposition, outcome)) {
      setBlocked(true);
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
      await patch({ notes });
    }
    await chain.current;
    if (share && channelId) {
      const body = callCardText(
        {
          direction: row?.direction ?? (p.inbound ? 'inbound' : 'outbound'),
          contactName: name,
          remoteNumber: p.remoteNumber,
          talkSeconds: Math.round(talkMs / 1000),
          outcome,
          notes,
        },
        {
          heading: (direction, who) => t('cardHeading', { direction, who }),
          direction: {
            inbound: t('directions.inbound'),
            outbound: t('directions.outbound'),
            internal: t('directions.internal'),
          },
          outcome: Object.fromEntries(
            OUTCOMES.map((o) => [o, t(`outcomes.${o}`)])
          ) as Record<Outcome, string>,
          noOutcome: t('noOutcome'),
          unknownCaller: t('unknownCaller'),
        }
      );
      try {
        await postMessage(sb, { channelId, body });
      } catch {
        toast.error(t('shareFailed'));
        return;
      }
    }
    calls.closePanel();
  };

  const round =
    'flex size-14 flex-col items-center justify-center gap-0.5 rounded-full bg-white/10 text-[10px] hover:bg-white/20 disabled:opacity-40';

  return (
    <aside
      aria-label={t('onCall', { extension: me.extension, mode: '' })}
      className="bg-card text-card-foreground fixed inset-0 z-50 flex flex-col shadow-2xl sm:inset-auto sm:top-14 sm:right-0 sm:bottom-0 sm:w-[530px] sm:border-l"
    >
      <div className="bg-[#101B18] p-5 text-white">
        <div className="flex items-center justify-between gap-2 text-xs text-white/70">
          <span>
            {t('onCall', {
              extension: me.extension,
              mode: calls.softphone ? t('modeBrowser') : t('modeDesk'),
            })}
          </span>
          {recording && !ended && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 font-medium text-white">
              ● {t('recording')}
            </span>
          )}
        </div>
        <p className="mt-2 truncate text-lg font-semibold">
          {[facts?.name, facts?.company].filter(Boolean).join(' · ') ||
            t('unknownCaller')}
        </p>
        <p className="mt-1 text-4xl font-semibold tabular-nums">
          {ended ? `${t('callEnded')} · ` : ''}
          {formatTimer(talkMs)}
        </p>
        {calls.settings.announcementRequired && (
          <p className="mt-1 text-xs text-white/55">{t('noticePlayed')}</p>
        )}
        {!row?.contact_id && !p.contactId && pickedId === undefined && (
          <CandidatePickerFor callKey={p.key} />
        )}
        {!ended && (
          <>
            <div className="mt-4 flex justify-center gap-4">
              <button
                type="button"
                className={round}
                onClick={async () =>
                  (await act(
                    () => calls.softphone!.mute(ref, !muted),
                    muted ? 'unmute' : 'mute'
                  )) && setMuted(!muted)
                }
              >
                {muted ? (
                  <MicOff className="size-5" />
                ) : (
                  <Mic className="size-5" />
                )}
                {muted ? t('unmute') : t('mute')}
              </button>
              <button
                type="button"
                className={round}
                onClick={async () =>
                  (await act(
                    () => calls.softphone!.hold(ref, !held),
                    held ? 'unhold' : 'hold'
                  )) && setHeld(!held)
                }
              >
                {held ? (
                  <Play className="size-5" />
                ) : (
                  <Pause className="size-5" />
                )}
                {held ? t('resume') : t('hold')}
              </button>
              <button
                type="button"
                className={round}
                onClick={() => setTransfer(transfer === null ? '' : null)}
              >
                <ArrowRightLeft className="size-5" />
                {t('transfer')}
              </button>
              {calls.softphone && (
                <button
                  type="button"
                  className={round}
                  onClick={() => setKeypad(!keypad)}
                >
                  <Grid3x3 className="size-5" />
                  {t('keypad')}
                </button>
              )}
            </div>
            {transfer !== null && (
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={transfer}
                  onChange={(e) => setTransfer(e.target.value)}
                  placeholder={t('transferNumber')}
                  aria-label={t('transferNumber')}
                  className="h-9 min-w-0 flex-1 rounded-lg bg-white/10 px-3 text-sm placeholder:text-white/40"
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
              </div>
            )}
            {keypad && calls.softphone && (
              <div className="mx-auto mt-3 grid w-48 grid-cols-3 gap-2">
                {[...'123456789*0#'].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="h-10 rounded-lg bg-white/10 text-lg"
                    onClick={() => void calls.softphone?.dtmf(ref, d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() =>
                void act(() => calls.softphone!.hangup(ref), 'hangup')
              }
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-medium hover:bg-red-500"
            >
              <Phone className="size-4 rotate-[135deg]" />
              {t('hangUp')}
            </button>
          </>
        )}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
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
                  setOutcome(next);
                  setBlocked(false);
                  void patch({ disposition: next });
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
              {save === 'saving'
                ? t('saving')
                : save === 'saved'
                  ? t('saved')
                  : save === 'failed'
                    ? t('notSaved')
                    : ''}
            </span>
          </span>
          <textarea
            value={notes}
            maxLength={4000}
            onChange={(e) => onNotes(e.target.value)}
            placeholder={t('notesPlaceholder')}
            className="border-input bg-background mt-1 min-h-28 w-full rounded-lg border p-2 text-sm"
          />
        </label>
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
              className="border-input bg-background rounded-md border px-2 py-1"
            >
              <option value="">#</option>
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
      <div className="border-t p-4">
        <button
          type="button"
          onClick={() => void close()}
          className="bg-muted hover:bg-muted/80 h-10 w-full rounded-lg text-sm font-medium"
        >
          {t('close')}
        </button>
      </div>
    </aside>
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
