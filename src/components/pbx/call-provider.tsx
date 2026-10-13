'use client';

// The call screens' state (module 015), mounted once in the dashboard
// shell: the caller's extension (/api/pbx/me), the call_live rows RLS
// shows them (realtime, plus a poll while a call is on screen: a row
// that stops being visible — answered by someone else, transferred
// away — sends this subscriber no event), and the in-call panel's
// snapshot, which outlives the live row until the panel is closed.
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
import { cachedQuery } from '@/lib/client-cache';
import {
  isInboundCall,
  liveKey,
  myActiveCall,
  myRingingCall,
  noteFrames,
  ringFloor,
  type CallLiveRow,
  type FrameSeen,
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
}

export interface PanelCall {
  key: string;
  connectionId: string;
  pbxCallId: string;
  contactId: string | null;
  remoteNumber: string | null;
  inbound: boolean;
  seenAt: number;
  endedAt: number | null;
}

export type CallControl = 'hangup' | 'hold' | 'unhold' | 'mute' | 'unmute';

interface CallsValue {
  me: PbxMe | null;
  userId: string | null;
  ringing: CallLiveRow | null;
  /** The ring timer's inputs for `ringing` (ringElapsedMs). */
  ringClock: { shownAt: number; frame: FrameSeen | null } | null;
  panel: PanelCall | null;
  closePanel: () => void;
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

/**
 * The panel follows my answered call; once I leave it, it stays (ended)
 * until closed, and only then can the next call take it.
 */
function nextPanel(
  prev: PanelCall | null,
  rows: CallLiveRow[],
  userId: string | null,
  now: number
): PanelCall | null {
  if (prev && prev.endedAt === null) {
    const still = rows.find(
      (r) => liveKey(r) === prev.key && r.answered_by === userId
    );
    if (!still) return { ...prev, endedAt: now };
    return still.contact_id !== prev.contactId
      ? { ...prev, contactId: still.contact_id }
      : prev;
  }
  const active = myActiveCall(rows, userId);
  if (prev || !active) return prev;
  return {
    key: liveKey(active),
    connectionId: active.connection_id,
    pbxCallId: active.pbx_call_id,
    contactId: active.contact_id,
    remoteNumber: active.remote_number,
    inbound: isInboundCall(active),
    seenAt: now,
    endedAt: null,
  };
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const supabase = useMemo(() => createClient(), []);
  const [me, setMe] = useState<PbxMe | null>(null);
  const [rows, setRows] = useState<CallLiveRow[]>([]);
  const [panel, setPanel] = useState<PanelCall | null>(null);
  const [adapter, setAdapter] = useState<SoftphoneAdapter | null>(null);
  const [adapterActive, setAdapterActive] = useState(false);
  const [softphoneState, setSoftphoneState] =
    useState<SoftphoneState>(SOFTPHONE_OFF);
  const [settings, setSettings] = useState({
    announcementRequired: true,
    mandatoryDisposition: false,
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [didNames, setDidNames] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [frames, setFrames] = useState<Record<string, FrameSeen>>({});
  const [ringShown, setRingShown] = useState<{
    key: string;
    at: number;
  } | null>(null);

  useEffect(() => {
    if (!userId || !accountId) return;
    let live = true;
    fetch('/api/pbx/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setMe(b?.extension ? (b as PbxMe) : null))
      .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [userId, accountId]);

  const rowsRef = useRef<CallLiveRow[]>([]);
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
      setPanel((p) => nextPanel(p, next, userId, now));
    },
    [userId]
  );
  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('call_live').select('*');
    if (error) return;
    apply((data ?? []) as CallLiveRow[], loadedRef.current);
    loadedRef.current = true;
  }, [supabase, apply]);

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
    void cachedQuery(`pbx-names:${accountId}`, 300_000, async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId);
      return Object.fromEntries(
        ((data ?? []) as { user_id: string; full_name: string }[]).map((p) => [
          p.user_id,
          p.full_name,
        ])
      );
    }).then(setNames);
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
    void supabase
      .from('pbx_settings')
      .select('announcement_required, mandatory_disposition')
      .maybeSingle()
      .then(({ data }) => {
        const s = data as {
          announcement_required: boolean;
          mandatory_disposition: boolean;
        } | null;
        if (s)
          setSettings({
            announcementRequired: s.announcement_required,
            mandatoryDisposition: s.mandatory_disposition,
          });
      });
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [me, accountId, userId, supabase, reload, apply]);

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
      closePanel: () =>
        setPanel(nextPanel(null, rowsRef.current, userId, Date.now())),
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
