'use client';

// The incoming-call card (module 015): floats top-right below the
// header for the customer call ringing this person, without dimming the
// page. Internal only. Desk-phone mode: the PBX rings the physical
// phone, so Answer only says where to pick up and Decline hangs up the
// person's own ringing leg; a registered softphone does both itself.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Circle, Phone, PhoneOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  alsoRinging,
  clip,
  consentText,
  contactCandidates,
  formatTimer,
  liveKey,
  maskPhone,
  type ConsentFields,
} from '@/lib/pbx/call-ui';
import { customerHref } from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';
import { useCalls } from './call-provider';

export interface CallFacts extends ConsentFields {
  name: string | null;
  company: string | null;
  phone: string | null;
  ownerId: string | null;
  conversationId: string | null;
  deal: string | null;
  last: { at: string; text: string } | null;
}

/** What the card and the panel show of a call's customer (RLS-filtered). */
export function useCallFacts(contactId: string | null): CallFacts | null {
  const [facts, setFacts] = useState<CallFacts | null>(null);
  useEffect(() => {
    if (!contactId) return;
    let live = true;
    const sb = createClient();
    void (async () => {
      const [c, d, conv] = await Promise.all([
        sb
          .from('contacts')
          .select(
            'name, company, phone, user_id, do_not_contact_at, do_not_contact_reason, marketing_opt_in_at, opted_out_at'
          )
          .eq('id', contactId)
          .maybeSingle(),
        sb
          .from('deals')
          .select('title, stage:pipeline_stages(name)')
          .eq('contact_id', contactId)
          .eq('status', 'open')
          .order('created_at', { ascending: false })
          .limit(1),
        sb
          .from('conversations')
          .select('id')
          .eq('contact_id', contactId)
          .limit(1),
      ]);
      const row = c.data as (ConsentFields & Record<string, string>) | null;
      const deal = (d.data?.[0] ?? null) as {
        title: string;
        stage: { name: string } | null;
      } | null;
      const convId = (conv.data?.[0] as { id: string } | undefined)?.id;
      let last: CallFacts['last'] = null;
      if (convId) {
        const m = await sb
          .from('messages')
          .select('content_text, content_type, created_at')
          .eq('conversation_id', convId)
          .order('created_at', { ascending: false })
          .limit(1);
        const msg = m.data?.[0] as
          | {
              content_text: string | null;
              content_type: string;
              created_at: string;
            }
          | undefined;
        if (msg)
          last = {
            at: msg.created_at,
            text: clip(msg.content_text || `[${msg.content_type}]`, 40),
          };
      }
      if (!live) return;
      setFacts({
        ...(row ?? {}),
        name: row?.name || null,
        company: row?.company || null,
        phone: row?.phone || null,
        ownerId: row?.user_id || null,
        conversationId: convId ?? null,
        deal: deal
          ? [deal.title, deal.stage?.name].filter(Boolean).join(' · ')
          : null,
        last,
      });
    })();
    return () => {
      live = false;
    };
  }, [contactId]);
  return contactId ? facts : null;
}

/** "Which customer?" for a number that matched several contacts. */
export function CandidatePicker({
  ids,
  value,
  onPick,
}: {
  ids: string[];
  value: string | null;
  onPick: (id: string | null) => void;
}) {
  const t = useTranslations('PbxCall');
  const [rows, setRows] = useState<{ id: string; label: string }[]>([]);
  const key = ids.join(',');
  useEffect(() => {
    let live = true;
    void createClient()
      .from('contacts')
      .select('id, name, company')
      .in('id', key.split(','))
      .then(({ data }) => {
        if (!live) return;
        setRows(
          (
            (data ?? []) as {
              id: string;
              name: string | null;
              company: string | null;
            }[]
          ).map((r) => ({
            id: r.id,
            label:
              [r.name, r.company].filter(Boolean).join(' · ') || t('unnamed'),
          }))
        );
      });
    return () => {
      live = false;
    };
  }, [key, t]);
  if (rows.length < 2) return null;
  return (
    <label className="mt-3 block text-xs">
      <span className="opacity-70">{t('whichCustomer')}</span>
      <select
        className="mt-1 w-full rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm"
        value={value ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
      >
        <option value="">—</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id} className="text-black">
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Ticks once a second while mounted. */
export function useNow(on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export function IncomingCallCard() {
  const calls = useCalls();
  const t = useTranslations('PbxCall');
  const call = calls?.ringing ?? null;
  const key = call ? liveKey(call) : null;
  const [since, setSince] = useState<{ key: string; at: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const now = useNow(Boolean(call));
  // Adjusted while rendering: the ring timer starts when this call shows.
  if (key && since?.key !== key) setSince({ key, at: now });
  const pickedId = key ? (calls?.picks[key] ?? null) : null;
  const facts = useCallFacts(call?.contact_id ?? pickedId);
  const candidates = useMemo(
    () => (call ? contactCandidates(call) : []),
    [call]
  );
  if (!calls || !call || !key) return null;

  const ref = { pbxCallId: call.pbx_call_id, remoteNumber: call.remote_number };
  const did =
    (call.did_number && calls.didNames[call.did_number]) || t('mainLine');
  const known = Boolean(call.contact_id || pickedId);
  const title =
    facts?.company || facts?.name || (known ? t('unnamed') : t('newCaller'));
  const person = facts?.company ? facts.name : null;
  const masked = maskPhone(call.remote_number ?? facts?.phone);
  const owner = facts?.ownerId
    ? facts.ownerId === calls.userId
      ? t('you', { name: calls.names[facts.ownerId] ?? '' })
      : (calls.names[facts.ownerId] ?? '—')
    : t('noOwner');
  const others = alsoRinging(call, calls.userId, calls.names);
  // The softphone adapter throws when the SDK refuses (not registered,
  // the call already gone); say so instead of an unhandled rejection.
  const failed = (err: unknown) =>
    toast.error(
      t('actionFailed', {
        message: err instanceof Error ? err.message : String(err),
      })
    );
  const answer = async () => {
    try {
      if (calls.softphone) await calls.softphone.answer(ref);
      else setHint(t('pickUpDesk'));
    } catch (err) {
      failed(err);
    }
  };
  const decline = async () => {
    try {
      if (calls.softphone) await calls.softphone.decline(ref);
      else await calls.control(call.pbx_call_id, 'hangup');
    } catch (err) {
      failed(err);
    }
  };
  const fact = (label: string, value: string) => (
    <>
      <dt className="text-white/55">{label}</dt>
      <dd className="truncate text-white/90">{value}</dd>
    </>
  );

  return (
    <div
      role="alertdialog"
      aria-label={t('incoming')}
      className="fixed top-[68px] right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] rounded-[18px] bg-[#101B18] p-4 text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)] [[data-mode=dark]_&]:ring-1 [[data-mode=dark]_&]:ring-white/10"
    >
      <p className="flex items-center gap-2 text-xs text-white/70">
        <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
        {t('incoming')} · {did} ·{' '}
        <span className="tabular-nums">
          {formatTimer(now - (since?.key === key ? since.at : now))}
        </span>
      </p>
      <p className="mt-2 truncate text-xl font-bold">{title}</p>
      <p className="truncate text-sm text-white/70">
        {[person, masked].filter(Boolean).join(' · ')}
      </p>
      {facts && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-white/[0.07] p-3 text-xs">
          {fact(t('owner'), owner)}
          {fact(t('openDeal'), facts.deal ?? t('none'))}
          {fact(
            t('lastWhatsApp'),
            facts.last
              ? `${new Date(facts.last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — “${facts.last.text}”`
              : t('none')
          )}
          {fact(
            t('consent'),
            consentText(facts, {
              callsOk: t('callsOk'),
              doNotContact: t('doNotContact'),
              marketingOn: t('marketingOn'),
              marketingOff: t('marketingOff'),
            })
          )}
        </dl>
      )}
      {!call.contact_id && candidates.length > 1 && (
        <CandidatePicker
          ids={candidates}
          value={pickedId}
          onPick={(id) => calls.pick(key, id)}
        />
      )}
      {calls.settings.announcementRequired && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/15 p-2.5 text-xs text-amber-200">
          <Circle className="mt-0.5 size-3 shrink-0 fill-red-500 text-red-500" />
          {t('recordedNotice')}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void decline()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-medium hover:bg-red-500"
        >
          <PhoneOff className="size-4" />
          {t('decline')}
        </button>
        <button
          type="button"
          onClick={() => void answer()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-medium hover:bg-emerald-500"
        >
          <Phone className="size-4" />
          {t('answer')}
        </button>
      </div>
      {hint && <p className="mt-2 text-center text-xs text-white/75">{hint}</p>}
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        {known ? (
          <Link
            href={customerHref({
              contactId: call.contact_id ?? pickedId,
              conversationId: facts?.conversationId,
            })}
            className="text-emerald-300 hover:underline"
          >
            {t('openCustomer')}
          </Link>
        ) : (
          <Link href="/contacts" className="text-emerald-300 hover:underline">
            {t('createContact')}
          </Link>
        )}
        {(others.names.length > 0 || others.more > 0) && (
          <span className="truncate text-white/50">
            {t('alsoRinging', {
              names: [
                ...others.names,
                ...(others.more ? [t('andMore', { count: others.more })] : []),
              ].join(', '),
            })}
          </span>
        )}
      </div>
    </div>
  );
}
