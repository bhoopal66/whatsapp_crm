'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Route, ShieldCheck, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { SHIPPED_WORKFLOW as DEF } from '@/lib/journeys/workflow';
import type { Product } from '@/lib/journeys/schema';
import type { AdvisorDecision, JourneyFile } from '@/lib/journeys/types';
import {
  OPT_IN_SOURCES,
  closeReasons,
  consentErrorKey,
  decisionOptions,
  journeyErrorKey,
  nextTimer,
  recentHistory,
  startBlocker,
  stateLabelKey,
  timerLabel,
  validUntilFromDate,
  windowStatus,
  type DecisionOption,
} from '@/lib/journeys/ui';

interface FileRow {
  id: string;
  state: string;
  product: Product | null;
  entry: 'INBOUND' | 'COLD' | null;
  body: Pick<JourneyFile, 'window' | 'timers' | 'outcome' | 'history'>;
  closed_at: string | null;
}
interface ConsentRow {
  marketing_opt_in_at: string | null;
  marketing_opt_in_source: string | null;
  do_not_contact_at: string | null;
  do_not_contact_reason: string | null;
  opted_out_at: string | null;
}
interface ConsentEvent {
  id: string;
  kind: string;
  at: string;
}

type Title = (p: { icon: LucideIcon; children: ReactNode }) => ReactNode;

const fieldClass =
  'bg-wa-search text-wa-text focus-visible:ring-wa-teal/40 w-full rounded-lg border-0 px-2 py-1.5 text-xs outline-none focus-visible:ring-2';
const date = (iso: string) => format(new Date(iso), 'MMM d, yyyy');
const dateTime = (iso: string) => format(new Date(iso), 'MMM d, HH:mm');

/**
 * The contact panel's Journey card and Consent block (module 016). One
 * load for both, because consent decides whether a journey can start;
 * reloaded after every action and whenever the panel shows another
 * contact (the parent keys it by contact).
 */
export function ContactJourneySections({
  contactId,
  SectionTitle,
}: {
  contactId: string;
  SectionTitle: Title;
}) {
  const t = useTranslations('Journeys');
  const { canSendMessages, canEditSettings } = useAuth();
  const [file, setFile] = useState<FileRow | null>(null);
  const [consent, setConsent] = useState<ConsentRow | null>(null);
  const [events, setEvents] = useState<ConsentEvent[]>([]);
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [f, c, e] = await Promise.all([
      supabase
        .from('journey_files')
        .select('id, state, product, entry, body, closed_at')
        .eq('contact_id', contactId)
        .order('closed_at', { ascending: false, nullsFirst: true })
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('contacts')
        .select(
          'marketing_opt_in_at, marketing_opt_in_source, do_not_contact_at, do_not_contact_reason, opted_out_at'
        )
        .eq('id', contactId)
        .maybeSingle(),
      supabase
        .from('contact_consent_events')
        .select('id, kind, at')
        .eq('contact_id', contactId)
        .order('at', { ascending: false })
        .limit(5),
    ]);
    if (f.error || c.error) toast.error(t('card.loadError'));
    setFile((f.data as FileRow | null) ?? null);
    setConsent((c.data as ConsentRow | null) ?? null);
    setEvents((e.data as ConsentEvent[] | null) ?? []);
    setNow(Date.now());
  }, [contactId, t]);

  useEffect(() => {
    load();
  }, [load]);

  /** POSTs a journey route; toasts the outcome; reloads. */
  const post = async (url: string, body: unknown, ok: string) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(t(`errors.${journeyErrorKey(json.code)}`));
      else if (
        json.warnings?.some(
          (w: { code: string }) => w.code === 'ALREADY_STARTED'
        )
      )
        toast.info(t('card.alreadyStarted'));
      else if (json.error) toast.warning(t('card.deliveryLater'));
      else toast.success(ok);
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
      await load();
    }
  };

  /** A plain contacts UPDATE as the user; the consent guard trigger decides. */
  const writeConsent = async (patch: Partial<ConsentRow>) => {
    setBusy(true);
    const { data, error } = await createClient()
      .from('contacts')
      .update(patch)
      .eq('id', contactId)
      .select('id');
    if (error || !data?.length)
      toast.error(t(`consent.errors.${consentErrorKey(error)}`));
    else toast.success(t('consent.saved'));
    setBusy(false);
    await load();
  };

  if (now === null) return null;
  const blocker = consent ? startBlocker(consent) : 'noOptIn';
  const open = file && file.closed_at === null;
  const stateLabel = (s: string) => (stateLabelKey(s) ? t(`states.${s}`) : s);

  return (
    <>
      <section className="bg-wa-panel px-5 py-4">
        <SectionTitle icon={Route}>{t('card.title')}</SectionTitle>
        <div className="mt-2.5 space-y-2 text-xs">
          {file ? (
            <JourneyDetails file={file} now={now} stateLabel={stateLabel} />
          ) : (
            <p className="text-wa-text-secondary">{t('card.none')}</p>
          )}
          {open && canSendMessages && (
            <DecisionPanel
              options={decisionOptions(DEF, {
                state: file.state,
                product: file.product,
                parkedReason:
                  file.body.outcome?.kind === 'PARKED'
                    ? file.body.outcome.reason
                    : null,
              })}
              busy={busy}
              onDecide={(body) =>
                post(`/api/journeys/${file.id}/advisor`, body, t('card.saved'))
              }
            />
          )}
          {!open && canSendMessages && (
            <div className="space-y-1">
              <Button
                size="sm"
                className="bg-wa-green text-wa-green-fg hover:bg-wa-green/90 h-7 text-xs"
                disabled={busy || blocker !== null}
                title={t('card.startHint')}
                onClick={() =>
                  post('/api/journeys/start', { contactId }, t('card.started'))
                }
              >
                {file ? t('card.startAgain') : t('card.start')}
              </Button>
              <p className="text-wa-text-secondary text-[11px]">
                {blocker ? t(`card.blocked.${blocker}`) : t('card.startHint')}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="bg-wa-panel px-5 py-4">
        <SectionTitle icon={ShieldCheck}>{t('consent.title')}</SectionTitle>
        {consent && (
          <ConsentControls
            consent={consent}
            events={events}
            busy={busy}
            canSet={canSendMessages}
            canClear={canEditSettings}
            onWrite={writeConsent}
          />
        )}
      </section>
    </>
  );
}

function JourneyDetails({
  file,
  now,
  stateLabel,
}: {
  file: FileRow;
  now: number;
  stateLabel: (s: string) => string;
}) {
  const t = useTranslations('Journeys');
  const fmt = useFormatter();
  const ws = windowStatus(
    file.body.window,
    new Date(now).toISOString(),
    DEF.windows
  );
  const timer = file.closed_at ? null : nextTimer(file.body.timers ?? []);
  const outcome = file.body.outcome;
  const reason = (r: string) => (t.has(`reasons.${r}`) ? t(`reasons.${r}`) : r);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-wa-text text-sm font-medium">
          {stateLabel(file.state)}
        </span>
        {file.product && (
          <span className="bg-wa-search text-wa-text-secondary rounded-full px-1.5 py-0.5 text-[10px]">
            {t(`products.${file.product}`)}
          </span>
        )}
        {file.entry && (
          <span className="text-wa-text-secondary text-[10px]">
            {t(`entry.${file.entry}`)}
          </span>
        )}
      </div>
      {!file.closed_at && (
        <p className="text-wa-text-secondary">
          {ws.kind === 'closed'
            ? t('card.window.closed')
            : t(`card.window.${ws.kind}`, { time: dateTime(ws.until) })}
        </p>
      )}
      {timer && (
        <p className="text-wa-text-secondary">
          {t('card.next', {
            label: t(`timers.${timerLabel(DEF, timer)}`),
            when: fmt.relativeTime(new Date(timer.fireAt), now),
          })}
        </p>
      )}
      {outcome && (
        <p className="text-wa-text">
          {t('card.outcome', {
            kind: t(`outcomes.${outcome.kind}`),
            reason: reason(outcome.reason),
          })}
          {file.closed_at && ` · ${date(file.closed_at)}`}
        </p>
      )}
      {(file.body.history ?? []).length > 0 && (
        <div>
          <p className="text-wa-text-secondary mt-1 text-[11px]">
            {t('card.history')}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {recentHistory(file.body.history).map((h, i) => (
              <li
                key={`${h.at}-${i}`}
                title={h.cause}
                className="text-wa-text-secondary truncate text-[11px]"
              >
                {dateTime(h.at)} · {stateLabel(h.to)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DecisionPanel({
  options,
  busy,
  onDecide,
}: {
  options: DecisionOption[];
  busy: boolean;
  onDecide: (body: {
    decision: AdvisorDecision;
    reasonCode?: string;
    validUntil?: string;
  }) => Promise<void>;
}) {
  const t = useTranslations('Journeys');
  const [picked, setPicked] = useState<DecisionOption | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  if (options.length === 0) return null;

  const choose = (o: DecisionOption | null) => {
    setPicked(o);
    setReason('');
    setUntil('');
  };
  if (!picked)
    return (
      <div className="flex flex-wrap gap-1.5 pt-1">
        {options.map((o) => (
          <Button
            key={o.decision}
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy}
            onClick={() => choose(o)}
          >
            {t(`decisions.${o.decision}`)}
          </Button>
        ))}
      </div>
    );

  const validUntil = until ? validUntilFromDate(until) : null;
  return (
    <div className="bg-wa-search space-y-2 rounded-lg p-2">
      <p className="text-wa-text font-medium">
        {t(`decisions.${picked.decision}`)}
      </p>
      {picked.needsReason && (
        <label className="block space-y-1">
          <span className="text-wa-text-secondary">{t('card.reason')}</span>
          <select
            className={fieldClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">{t('card.chooseReason')}</option>
            {closeReasons(DEF).map((r) => (
              <option key={r} value={r}>
                {t.has(`reasons.${r}`) ? t(`reasons.${r}`) : r}
              </option>
            ))}
          </select>
        </label>
      )}
      {picked.acceptsValidUntil && (
        <label className="block space-y-1">
          <span className="text-wa-text-secondary">{t('card.validUntil')}</span>
          <input
            type="date"
            className={fieldClass}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
      )}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || (picked.needsReason && !reason)}
          onClick={async () => {
            await onDecide({
              decision: picked.decision,
              ...(reason ? { reasonCode: reason } : {}),
              ...(validUntil ? { validUntil } : {}),
            });
            choose(null);
          }}
        >
          {t('card.confirm')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => choose(null)}
        >
          {t('card.cancel')}
        </Button>
      </div>
    </div>
  );
}

function ConsentControls({
  consent,
  events,
  busy,
  canSet,
  canClear,
  onWrite,
}: {
  consent: ConsentRow;
  events: ConsentEvent[];
  busy: boolean;
  canSet: boolean;
  canClear: boolean;
  onWrite: (patch: Partial<ConsentRow>) => Promise<void>;
}) {
  const t = useTranslations('Journeys.consent');
  const [editing, setEditing] = useState<'optIn' | 'dnc' | null>(null);
  const [value, setValue] = useState('');
  const edit = (what: 'optIn' | 'dnc' | null) => {
    setEditing(what);
    setValue('');
  };
  const source = (s: string | null) =>
    s && t.has(`sources.${s}`) ? t(`sources.${s}`) : (s ?? '');
  const save = async () => {
    const at = new Date().toISOString();
    await onWrite(
      editing === 'optIn'
        ? { marketing_opt_in_at: at, marketing_opt_in_source: value }
        : { do_not_contact_at: at, do_not_contact_reason: value.trim() }
    );
    edit(null);
  };

  return (
    <div className="mt-2.5 space-y-2.5 text-xs">
      {consent.opted_out_at && (
        <span className="bg-destructive/10 text-destructive inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium">
          {t('optedOut')} · {date(consent.opted_out_at)}
        </span>
      )}
      <div>
        <p className="text-wa-text font-medium">{t('optIn')}</p>
        <p className="text-wa-text-secondary">
          {consent.marketing_opt_in_at
            ? t('optInAt', {
                date: date(consent.marketing_opt_in_at),
                source: source(consent.marketing_opt_in_source),
              })
            : t('none')}
        </p>
        {!consent.marketing_opt_in_at && canSet && editing !== 'optIn' && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1 h-7 px-2 text-[11px]"
            disabled={busy}
            onClick={() => edit('optIn')}
          >
            {t('record')}
          </Button>
        )}
      </div>
      <div>
        <p className="text-wa-text font-medium">{t('dnc')}</p>
        <p className="text-wa-text-secondary">
          {consent.do_not_contact_at
            ? t('dncAt', {
                date: date(consent.do_not_contact_at),
                reason: consent.do_not_contact_reason ?? '',
              })
            : t('dncNone')}
        </p>
        {!consent.do_not_contact_at && canSet && editing !== 'dnc' && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1 h-7 px-2 text-[11px]"
            disabled={busy}
            onClick={() => edit('dnc')}
          >
            {t('setDnc')}
          </Button>
        )}
        {consent.do_not_contact_at && canSet && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1 h-7 px-2 text-[11px]"
            disabled={busy || !canClear}
            title={canClear ? undefined : t('clearAdminOnly')}
            onClick={() =>
              onWrite({ do_not_contact_at: null, do_not_contact_reason: null })
            }
          >
            {t('clear')}
          </Button>
        )}
      </div>
      {editing && (
        <div className="bg-wa-search space-y-2 rounded-lg p-2">
          {editing === 'optIn' ? (
            <select
              aria-label={t('source')}
              className={fieldClass}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="">{t('chooseSource')}</option>
              {OPT_IN_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`sources.${s}`)}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={t('dncReason')}
              placeholder={t('dncReason')}
              className={fieldClass}
              value={value}
              maxLength={200}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !value.trim()}
              onClick={save}
            >
              {t('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => edit(null)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {events.length > 0 && (
        <div>
          <p className="text-wa-text-secondary text-[11px]">{t('history')}</p>
          <ul className="mt-0.5 space-y-0.5">
            {events.map((e) => (
              <li key={e.id} className="text-wa-text-secondary text-[11px]">
                {dateTime(e.at)} ·{' '}
                {t.has(`events.${e.kind}`) ? t(`events.${e.kind}`) : e.kind}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
