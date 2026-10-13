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
  consentText,
  contactCandidates,
  factsFor,
  formatTimer,
  liveKey,
  maskPhone,
  messageWhen,
  newContactPhone,
  otherOwner,
  ringElapsedMs,
  type HeldFacts,
} from '@/lib/pbx/call-ui';
import {
  UNKNOWN_FACTS,
  loadVisibleFacts,
  parseCallFacts,
  type CallFacts,
} from '@/lib/pbx/call-facts';
import { customerHref } from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';
import { ContactForm } from '@/components/contacts/contact-form';
import { useCan } from '@/hooks/use-can';
import { useCalls } from './call-provider';

export type { CallFacts };

/**
 * What the card and the panel show of a call's customer, held with the
 * contact and the call it was loaded for (factsFor): the card stays
 * mounted from one call to the next. For a live call of mine, the facts route (a contact
 * my own reads hide still shows its name, owner and consent); otherwise,
 * or when the route refuses, my own reads, where a hidden contact shows
 * nothing and its consent as unknown.
 */
export function useCallFacts(
  contactId: string | null,
  live: { connectionId: string; pbxCallId: string } | null = null
): CallFacts | null {
  const [held, setHeld] = useState<HeldFacts<CallFacts> | null>(null);
  const connectionId = live?.connectionId ?? null;
  const pbxCallId = live?.pbxCallId ?? null;
  const callKey =
    connectionId && pbxCallId
      ? liveKey({ connection_id: connectionId, pbx_call_id: pbxCallId })
      : null;
  useEffect(() => {
    if (!contactId) return;
    let on = true;
    void (async () => {
      let facts: CallFacts | null = null;
      if (connectionId && pbxCallId) {
        const res = await fetch(
          `/api/pbx/calls/facts?${new URLSearchParams({
            connectionId,
            pbxCallId,
            contactId,
          })}`
        ).catch(() => null);
        if (res?.ok) facts = parseCallFacts(await res.json().catch(() => null));
      }
      facts ??=
        (await loadVisibleFacts(createClient(), contactId).catch(() => null)) ??
        UNKNOWN_FACTS;
      if (on) setHeld({ contactId, callKey, facts });
    })();
    return () => {
      on = false;
    };
  }, [contactId, connectionId, pbxCallId, callKey]);
  return factsFor(held, contactId, callKey);
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

/** The call a "Create contact" form was opened for. */
interface NewCaller {
  key: string;
  connectionId: string;
  pbxCallId: string;
  phone: string;
}

export function IncomingCallCard() {
  const calls = useCalls();
  const t = useTranslations('PbxCall');
  const canCreateContact = useCan('send-messages');
  const call = calls?.ringing ?? null;
  const key = call ? liveKey(call) : null;
  const [hint, setHint] = useState<string | null>(null);
  const [creating, setCreating] = useState<NewCaller | null>(null);
  const now = useNow(Boolean(call));
  const pickedId = key ? (calls?.picks[key] ?? null) : null;
  const facts = useCallFacts(
    call?.contact_id ?? pickedId,
    call
      ? { connectionId: call.connection_id, pbxCallId: call.pbx_call_id }
      : null
  );
  const candidates = useMemo(
    () => (call ? contactCandidates(call) : []),
    [call]
  );

  // The card shows the new contact, and the in-call panel links an
  // answered call to it (picks). A call still live is matched by its
  // number when it ends; one that ended while the form was open was
  // matched before the contact existed, so the route links it.
  const linkNewCaller = async (c: NewCaller, contactId: string) => {
    calls?.pick(c.key, contactId);
    const res = await fetch('/api/pbx/calls/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: c.connectionId,
        pbxCallId: c.pbxCallId,
        contactId,
      }),
    }).catch(() => null);
    if (!res?.ok) return void toast.error(t('linkFailed'));
    // 200 { linked: false }: not a call of mine, or it has a customer.
    const body = (await res.json().catch(() => null)) as {
      linked?: unknown;
    } | null;
    if (body?.linked !== true) toast.warning(t('linkSkipped'));
  };
  // Outside the card: the call can be answered, declined or missed
  // while the form is open, and what was typed must survive that.
  // Floating (no backdrop, non-modal, outside presses keep it open), so
  // Answer and Decline stay clickable beside it.
  const form = (
    <ContactForm
      floating
      open={creating !== null}
      onOpenChange={(open) => {
        if (!open) setCreating(null);
      }}
      initialPhone={creating?.phone}
      onSaved={(contactId) => {
        if (creating && contactId) void linkNewCaller(creating, contactId);
      }}
    />
  );
  if (!calls || !call || !key) return form;

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
      : (calls.names[facts.ownerId] ?? facts.ownerName ?? '—')
    : t('noOwner');
  const ownedBy = otherOwner(facts?.ownerId, calls.userId);
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
    <>
      {form}
      <div
        role="alertdialog"
        aria-label={t('incoming')}
        // Above the floating form where a narrow screen overlaps them.
        className={`fixed top-[68px] right-4 ${creating ? 'z-[60]' : 'z-50'} w-[380px] max-w-[calc(100vw-2rem)] rounded-[18px] bg-[#101B18] p-4 text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)] [[data-mode=dark]_&]:ring-1 [[data-mode=dark]_&]:ring-white/10`}
      >
        <p className="flex items-center gap-2 text-xs text-white/70">
          <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
          {t('incoming')} · {did} ·{' '}
          <span className="tabular-nums">
            {formatTimer(
              ringElapsedMs(
                call,
                calls.ringClock?.frame ?? null,
                calls.ringClock?.shownAt ?? now,
                now
              )
            )}
          </span>
        </p>
        <p className="mt-2 truncate text-xl font-bold">{title}</p>
        <p className="truncate text-sm text-white/70">
          {[person, masked].filter(Boolean).join(' · ')}
        </p>
        {ownedBy && (
          <p className="mt-2 rounded-xl bg-sky-400/15 px-2.5 py-1.5 text-xs font-medium text-sky-100">
            {t('ownedBy', {
              name: calls.names[ownedBy] ?? facts?.ownerName ?? '—',
            })}
          </p>
        )}
        {facts && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-white/[0.07] p-3 text-xs">
            {fact(t('owner'), owner)}
            {!facts.hidden && fact(t('openDeal'), facts.deal ?? t('none'))}
            {!facts.hidden &&
              fact(
                t('lastWhatsApp'),
                facts.last
                  ? `${messageWhen(facts.last.at, now)} — “${facts.last.text}”`
                  : t('none')
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
            {facts.hidden && (
              <p className="col-span-2 mt-1 text-white/60">
                {t('detailsHidden')}
              </p>
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
        {hint && (
          <p className="mt-2 text-center text-xs text-white/75">{hint}</p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          {known && facts?.hidden ? (
            <span />
          ) : known ? (
            <Link
              href={customerHref({
                contactId: call.contact_id ?? pickedId,
                conversationId: facts?.conversationId,
              })}
              className="text-emerald-300 hover:underline"
            >
              {t('openCustomer')}
            </Link>
          ) : canCreateContact ? (
            <button
              type="button"
              onClick={() =>
                setCreating({
                  key,
                  connectionId: call.connection_id,
                  pbxCallId: call.pbx_call_id,
                  phone: newContactPhone(call.remote_number),
                })
              }
              className="text-emerald-300 hover:underline"
            >
              {t('createContact')}
            </button>
          ) : (
            <span />
          )}
          {(others.names.length > 0 || others.more > 0) && (
            <span className="truncate text-white/50">
              {t('alsoRinging', {
                names: [
                  ...others.names,
                  ...(others.more
                    ? [t('andMore', { count: others.more })]
                    : []),
                ].join(', '),
              })}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
