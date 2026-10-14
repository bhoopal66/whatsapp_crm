'use client';

// The call screens' state (module 015), mounted once in the dashboard
// shell: the caller's extension (/api/pbx/me), the call_live rows RLS
// shows them (realtime, plus a poll while a call is on screen: a row
// that stops being visible — answered by someone else, transferred
// away — sends this subscriber no event), and the in-call panel's
// snapshot, which outlives the live row until the panel is closed. A
// live call always has the panel (selectPanel); unfinished wrap-ups
// wait behind it and re-open after.
// Nothing here sends anything to a customer.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { loadPbxNames } from '@/hooks/use-pbx-names';
import { cachedQuery } from '@/lib/client-cache';
import {
  NO_PANEL,
  closeWrapUp,
  liveKey,
  loadsPbxMe,
  myRingingCall,
  noteFrames,
  noteOutcome,
  recoverWrapUps,
  ringFloor,
  selectPanel,
  wrapUpPanel,
  type CallLiveRow,
  type FrameSeen,
  type PanelCall,
  type PanelState,
  type WrapUpCall,
} from '@/lib/pbx/call-ui';
import { SOFTPHONE_OFF, type SoftphoneState } from '@/lib/pbx/linkus-state';
import type { SoftphoneAdapter } from '@/lib/pbx/softphone';
import { createClient } from '@/lib/supabase/client';

export interface PbxMe {
  extension: string;
  connectionId: string;
  softphoneEnabled: boolean;
  softphoneAvailable: boolean;
  pbxUrl: string;
  /** The status the PBX last reported for the extension; null unknown. */
  presence: string | null;
}

export type { PanelCall };

export type CallControl = 'hangup' | 'hold' | 'unhold' | 'mute' | 'unmute';

interface CallsValue {
  me: PbxMe | null;
  userId: string | null;
  ringing: CallLiveRow | null;
  /** The ring timer's inputs for `ringing` (ringElapsedMs). */
  ringClock: { shownAt: number; frame: FrameSeen | null } | null;
  panel: PanelCall | null;
  /** Closes the panel of that call: never a live one (closeWrapUp). */
  closePanel: (key: string) => void;
  /** The panel reports whether its call has an outcome chosen. */
  noteOutcome: (key: string, chosen: boolean) => void;
  softphone: SoftphoneAdapter | null;
  registerSoftphone: (a: SoftphoneAdapter) => () => void;
  /** The browser softphone's status (SoftphoneMount), for a status line. */
  softphoneState: SoftphoneState;
  reportSoftphone: (s: SoftphoneState) => void;
  control: (
    pbxCallId: string,
    action: CallControl | 'transfer',
    body?: object
  ) => Promise<boolean>;
  settings: { announcementRequired: boolean; mandatoryDisposition: boolean };
  names: Record<string, string>;
  didNames: Record<string, string>;
  picks: Record<string, string>;
  pick: (key: string, contactId: string | null) => void;
}

const CallsContext = createContext<CallsValue | null>(null);

/** Null outside the provider (and for a person with no extension: `me`). */
export const useCalls = () => useContext(CallsContext);

const POLL_MS = 4000;

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user, accountId, accountRole } = useAuth();
  const userId = user?.id ?? null;
  const asksMe = loadsPbxMe(userId, accountId, accountRole);
  const supabase = useMemo(() => createClient(), []);
  const [me, setMe] = useState<PbxMe | null>(null);
  const [rows, setRows] = useState<CallLiveRow[]>([]);
  const [panels, setPanels] = useState<PanelState>(NO_PANEL);
  const panel = panels.panel;
  const [adapter, setAdapter] = useState<SoftphoneAdapter | null>(null);
  const [adapterActive, setAdapterActive] = useState(false);
  const [softphoneState, setSoftphoneState] =
    useState<SoftphoneState>(SOFTPHONE_OFF);
  const [settings, setSettings] = useState({
    announcementRequired: true,
    mandatoryDisposition: false,
  });
  // For the panel selection, which runs inside state updaters.
  const mandatoryRef = useRef(false);
  useEffect(() => {
    mandatoryRef.current = settings.mandatoryDisposition;
  }, [settings.mandatoryDisposition]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [didNames, setDidNames] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [frames, setFrames] = useState<Record<string, FrameSeen>>({});
  const [ringShown, setRingShown] = useState<{
    key: string;
    at: number;
  } | null>(null);

  useEffect(() => {
    // A bank guest has no phone here; me stays null, and with it the
    // subscription, the poll and the softphone.
    if (!asksMe) return;
    let live = true;
    fetch('/api/pbx/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setMe(b?.extension ? (b as PbxMe) : null))
      .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [asksMe, userId, accountId]);

  const rowsRef = useRef<CallLiveRow[]>([]);

  // A reload mid-wrap-up re-opens it (§7.3): my own calls that ended
  // under two minutes ago with no outcome (or, where outcomes are
  // mandatory, still owe one), newest first. They join the queue, so a
  // live call keeps or takes the panel whichever answer lands first. The
  // rule comes in the same answer and is applied with them, so a
  // recovered wrap-up is never timed against the default (not
  // mandatory) and closed before the settings load.
  useEffect(() => {
    if (!me) return;
    let live = true;
    fetch('/api/pbx/calls/wrap-up')
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { calls?: WrapUpCall[]; mandatory?: boolean } | null) => {
        if (!live || !b?.calls?.length) return;
        const now = Date.now();
        const recovered = b.calls.map((c) => wrapUpPanel(c, now));
        const mandatory = b.mandatory === true;
        mandatoryRef.current = mandatory;
        setSettings((s) =>
          s.mandatoryDisposition === mandatory
            ? s
            : { ...s, mandatoryDisposition: mandatory }
        );
        setPanels((s) =>
          recoverWrapUps(s, recovered, rowsRef.current, userId, now, mandatory)
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [me, userId]);

  // `live`: these rows' new frames arrived as they happened. The first
  // load's were written an unknown time before (noteFrames).
  const loadedRef = useRef(false);
  const apply = useCallback(
    (next: CallLiveRow[], live: boolean) => {
      const now = Date.now();
      rowsRef.current = next;
      setRows(next);
      setFrames((f) => noteFrames(f, next, now, live));
      setRingShown((s) => ringFloor(s, myRingingCall(next, userId), now));
      setPanels((s) => selectPanel(s, next, userId, now, mandatoryRef.current));
    },
    [userId]
  );
  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('call_live').select('*');
    if (error) return;
    apply((data ?? []) as CallLiveRow[], loadedRef.current);
    loadedRef.current = true;
  }, [supabase, apply]);

  const refreshSettings = useCallback(() => {
    void supabase
      .from('pbx_settings')
      .select('announcement_required, mandatory_disposition')
      .maybeSingle()
      .then(({ data }) => {
        const s = data as {
          announcement_required: boolean;
          mandatory_disposition: boolean;
        } | null;
        if (!s) return;
        mandatoryRef.current = s.mandatory_disposition;
        setSettings((cur) =>
          cur.announcementRequired === s.announcement_required &&
          cur.mandatoryDisposition === s.mandatory_disposition
            ? cur
            : {
                announcementRequired: s.announcement_required,
                mandatoryDisposition: s.mandatory_disposition,
              }
        );
      });
  }, [supabase]);

  useEffect(() => {
    if (!me || !accountId) return;
    const ch = supabase
      .channel(`call-live-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'call_live' },
        (p) => {
          if (p.eventType === 'DELETE') {
            const k = liveKey(p.old as CallLiveRow);
            apply(
              rowsRef.current.filter((r) => liveKey(r) !== k),
              true
            );
            return;
          }
          const row = p.new as CallLiveRow;
          apply(
            [
              ...rowsRef.current.filter((r) => liveKey(r) !== liveKey(row)),
              row,
            ],
            true
          );
        }
      )
      .subscribe((status) => {
        // The first load waits for the channel, so no change falls between.
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR')
          void reload();
      });
    void loadPbxNames(supabase, accountId).then(setNames);
    void cachedQuery(`pbx-dids:${accountId}`, 300_000, async () => {
      const { data } = await supabase
        .from('pbx_did_routes')
        .select('did_number, name_on_pbx');
      return Object.fromEntries(
        ((data ?? []) as { did_number: string; name_on_pbx: string | null }[])
          .filter((d) => d.name_on_pbx)
          .map((d) => [d.did_number, d.name_on_pbx as string])
      );
    }).then(setDidNames);
    refreshSettings();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [me, accountId, userId, supabase, reload, apply, refreshSettings]);

  // A setting changed mid-shift applies without a reload: read again
  // when the tab regains focus and whenever a wrap-up starts (the rule
  // decides whether it can close by itself).
  const wrapping = panel && panel.endedAt !== null ? panel.key : null;
  useEffect(() => {
    if (!me) return;
    window.addEventListener('focus', refreshSettings);
    return () => window.removeEventListener('focus', refreshSettings);
  }, [me, refreshSettings]);
  useEffect(() => {
    if (me && wrapping) refreshSettings();
  }, [me, wrapping, refreshSettings]);

  const ringing = me ? myRingingCall(rows, userId) : null;
  const ringKey = ringing ? liveKey(ringing) : null;
  const ringClock = useMemo(
    () =>
      ringKey && ringShown?.key === ringKey
        ? { shownAt: ringShown.at, frame: frames[ringKey] ?? null }
        : null,
    [ringKey, ringShown, frames]
  );

  const polling = Boolean(ringing || (panel && panel.endedAt === null));
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [polling, reload]);

  useEffect(() => {
    if (!adapter) return;
    const sync = () => setAdapterActive(adapter.isActive());
    sync();
    return adapter.subscribe(sync);
  }, [adapter]);

  const reportOutcome = useCallback(
    (key: string, chosen: boolean) =>
      setPanels((s) => noteOutcome(s, key, chosen)),
    []
  );

  const registerSoftphone = useCallback((a: SoftphoneAdapter) => {
    setAdapter(a);
    return () => setAdapter((cur) => (cur === a ? null : cur));
  }, []);

  const control = useCallback(
    async (pbxCallId: string, action: string, body?: object) => {
      try {
        const res = await fetch(
          `/api/pbx/calls/${encodeURIComponent(pbxCallId)}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          }
        );
        if (res.ok) return true;
        const b = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(b?.error ?? res.statusText);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      return false;
    },
    []
  );

  const value = useMemo<CallsValue>(
    () => ({
      me,
      userId,
      ringing,
      ringClock,
      panel,
      closePanel: (key) =>
        setPanels((s) =>
          closeWrapUp(
            s,
            key,
            rowsRef.current,
            userId,
            Date.now(),
            mandatoryRef.current
          )
        ),
      noteOutcome: reportOutcome,
      softphone: adapter && adapterActive ? adapter : null,
      registerSoftphone,
      softphoneState,
      reportSoftphone: setSoftphoneState,
      control,
      settings,
      names,
      didNames,
      picks,
      pick: (key, contactId) =>
        setPicks((p) => {
          const next = { ...p };
          if (contactId) next[key] = contactId;
          else delete next[key];
          return next;
        }),
    }),
    [
      me,
      userId,
      ringing,
      ringClock,
      panel,
      reportOutcome,
      adapter,
      adapterActive,
      registerSoftphone,
      softphoneState,
      control,
      settings,
      names,
      didNames,
      picks,
    ]
  );

  return (
    <CallsContext.Provider value={value}>{children}</CallsContext.Provider>
  );
}
