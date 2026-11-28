'use client';

/**
 * Coordinators and cover (migration 232). `CoverCard` is the desk's
 * Overview view for team leaders and up: each bank's primary and second
 * coordinator (read-only), who covers today, and each holder's leave.
 * `CoverRolesEditor` is the owners' and admins' half, in Settings -> Case
 * desk: it names the primary and second coordinator of each bank.
 * `MyLeaveCard` (328) is every staff member's own leave, under My uploads:
 * an agent cannot read the cover list, so this is where they add, change
 * and cancel theirs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import type { BankCover, CoverHolder, LeaveRange } from '@/lib/desk/cover';

import { deskApi } from './desk-api';
import { DeskSelect } from './desk-select';
import { LoadFailed } from './load-failed';

function useCover() {
  const [banks, setBanks] = useState<BankCover[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    () =>
      deskApi.cover().then((r) => {
        setFailed(!r.ok);
        if (r.ok) setBanks(r.data);
        else toast.error(r.error);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { banks, failed, load };
}

export function CoverCard() {
  const t = useTranslations('Desk');
  const { banks, failed, load } = useCover();

  const done = async (r: { ok: boolean; error?: string }) => {
    if (!r.ok) toast.error(r.error ?? '');
    else toast.success(t('cover.saved'));
    await load();
  };

  if (!banks) return <CoverMissing failed={failed} onRetry={load} />;
  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('cover.title')}
          </h2>
          <p className="text-muted-foreground">{t('cover.intro')}</p>
        </div>
        {banks.length === 0 && (
          <p className="text-muted-foreground">{t('cover.noBanks')}</p>
        )}
        {banks.map((b) => {
          const nameOf = (id: string | null) =>
            b.holders.find((h) => h.userId === id)?.name ?? null;
          return (
            <div key={b.bankCode} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-foreground font-medium">
                  {b.bankName}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('cover.today', {
                    name: nameOf(b.coverUser) ?? t('cover.lead'),
                  })}{' '}
                  ({t(`cover.levels.${b.coverLevel}`)})
                </span>
              </div>
              <p className="text-muted-foreground">
                {t('cover.primary')}: {nameOf(b.primaryUser) ?? t('cover.none')}
                {' · '}
                {t('cover.second')}: {nameOf(b.secondUser) ?? t('cover.none')}
              </p>
              <ul className="space-y-1">
                {b.holders.map((h) => (
                  <HolderLeave key={h.userId} holder={h} onDone={done} />
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function CoverMissing({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => unknown;
}) {
  const t = useTranslations('Desk');
  if (!failed) return null;
  return (
    <Card>
      <CardContent>
        <LoadFailed title={t('cover.title')} onRetry={onRetry} />
      </CardContent>
    </Card>
  );
}

export function HolderLeave({
  holder,
  onDone,
}: {
  holder: CoverHolder;
  onDone: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const t = useTranslations('Desk');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  // A ref too: a second click can arrive before the disabled render.
  const adding = useRef(false);
  const add = async () => {
    if (adding.current) return;
    adding.current = true;
    setBusy(true);
    const r = await deskApi.addLeave({
      userId: holder.userId,
      firstDay: first,
      lastDay: last,
    });
    if (r.ok) {
      setFirst('');
      setLast('');
    }
    await onDone(r);
    adding.current = false;
    setBusy(false);
  };
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-32">{holder.name}</span>
      {holder.onLeave && (
        <Badge variant="secondary">{t('cover.onLeave')}</Badge>
      )}
      {holder.leave.map((l) => (
        <span
          key={l.id}
          className="text-muted-foreground flex items-center gap-1 text-xs"
        >
          {t('cover.leaveRange', { first: l.firstDay, last: l.lastDay })}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => onDone(await deskApi.removeLeave(l.id))}
          >
            {t('cover.remove')}
          </Button>
        </span>
      ))}
      <span className="ms-auto flex flex-wrap items-center gap-1">
        <Input
          type="date"
          className="w-36"
          aria-label={t('cover.from')}
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <Input
          type="date"
          className="w-36"
          aria-label={t('cover.to')}
          value={last}
          onChange={(e) => setLast(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !first || !last}
          onClick={() => void add()}
        >
          {t('cover.addLeave')}
        </Button>
      </span>
    </li>
  );
}

export function MyLeaveCard() {
  const t = useTranslations('Desk');
  const { user } = useAuth();
  const [leave, setLeave] = useState<LeaveRange[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  // A ref too: a second click can arrive before the disabled render.
  const working = useRef(false);
  const load = useCallback(
    () =>
      deskApi.myLeave().then((r) => {
        setFailed(!r.ok);
        if (r.ok) setLeave(r.data);
        else toast.error(r.error);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (
    act: () => Promise<{ ok: boolean; error?: string }>,
    after?: () => void
  ) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    const r = await act();
    if (!r.ok) toast.error(r.error ?? '');
    else {
      toast.success(t('cover.saved'));
      after?.();
    }
    await load();
    working.current = false;
    setBusy(false);
  };

  if (!leave) {
    if (!failed) return null;
    return (
      <Card>
        <CardContent>
          <LoadFailed title={t('cover.myTitle')} onRetry={load} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-3 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('cover.myTitle')}
          </h2>
          <p className="text-muted-foreground">{t('cover.myIntro')}</p>
        </div>
        {leave.length === 0 && (
          <p className="text-muted-foreground">{t('cover.myNone')}</p>
        )}
        <ul className="space-y-2">
          {leave.map((l) => (
            <MyLeaveRow
              key={`${l.id}:${l.firstDay}:${l.lastDay}`}
              leave={l}
              busy={busy}
              onSave={(firstDay, lastDay) =>
                void run(() => deskApi.changeLeave(l.id, { firstDay, lastDay }))
              }
              onRemove={() => void run(() => deskApi.removeLeave(l.id))}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-1">
          <DayRange
            first={first}
            last={last}
            onFirst={setFirst}
            onLast={setLast}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !user || !first || !last}
            onClick={() =>
              void run(
                () =>
                  deskApi.addLeave({
                    userId: user?.id ?? '',
                    firstDay: first,
                    lastDay: last,
                  }),
                () => {
                  setFirst('');
                  setLast('');
                }
              )
            }
          >
            {t('cover.addLeave')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MyLeaveRow({
  leave,
  busy,
  onSave,
  onRemove,
}: {
  leave: LeaveRange;
  busy: boolean;
  onSave: (firstDay: string, lastDay: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('Desk');
  const [first, setFirst] = useState(leave.firstDay);
  const [last, setLast] = useState(leave.lastDay);
  const changed = first !== leave.firstDay || last !== leave.lastDay;
  return (
    <li className="flex flex-wrap items-center gap-1">
      <DayRange first={first} last={last} onFirst={setFirst} onLast={setLast} />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !changed || !first || !last}
        onClick={() => onSave(first, last)}
      >
        {t('cover.save')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
        {t('cover.remove')}
      </Button>
    </li>
  );
}

function DayRange({
  first,
  last,
  onFirst,
  onLast,
}: {
  first: string;
  last: string;
  onFirst: (v: string) => void;
  onLast: (v: string) => void;
}) {
  const t = useTranslations('Desk');
  return (
    <>
      <Input
        type="date"
        className="w-36"
        aria-label={t('cover.from')}
        value={first}
        onChange={(e) => onFirst(e.target.value)}
      />
      <Input
        type="date"
        className="w-36"
        aria-label={t('cover.to')}
        value={last}
        onChange={(e) => onLast(e.target.value)}
      />
    </>
  );
}

export function CoverRolesEditor() {
  const t = useTranslations('Desk');
  const ts = useTranslations('CaseDeskSettings');
  const { banks, failed, load } = useCover();
  if (!banks) return <CoverMissing failed={failed} onRetry={load} />;
  const set = async (
    bankCode: string,
    role: 'primary' | 'second',
    userId: string
  ) => {
    const r = await deskApi.setBankRole(bankCode, role, userId || null);
    if (!r.ok) toast.error(r.error);
    else toast.success(t('cover.saved'));
    await load();
  };
  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{ts('rolesIntro')}</p>
        {banks.length === 0 && (
          <p className="text-muted-foreground">{t('cover.noBanks')}</p>
        )}
        {banks.map((b) => (
          <div key={b.bankCode} className="space-y-2 rounded-md border p-3">
            <span className="text-foreground font-medium">{b.bankName}</span>
            <div className="flex flex-wrap gap-3">
              {(['primary', 'second'] as const).map((role) => (
                <div key={role} className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {t(`cover.${role}`)}
                  </span>
                  <DeskSelect
                    className="w-48"
                    ariaLabel={`${b.bankName}: ${t(`cover.${role}`)}`}
                    value={
                      (role === 'primary' ? b.primaryUser : b.secondUser) ?? ''
                    }
                    noneLabel={t('cover.none')}
                    placeholder={t('cover.none')}
                    options={b.holders.map((h) => ({
                      value: h.userId,
                      label: h.name,
                    }))}
                    onChange={(v) => void set(b.bankCode, role, v)}
                  />
                </div>
              ))}
            </div>
            {b.holders.length === 0 && (
              <p className="text-muted-foreground text-xs">{ts('noHolders')}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
