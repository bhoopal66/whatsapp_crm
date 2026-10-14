'use client';

// The Calls screen's Colleagues tab (?tab=colleagues): every extension
// on the caller's phone system with the person's live phone state, and
// a Call button (useDial through CallButton, like every other). The
// rules (which dot, which order, the search) are lib/pbx/colleagues.ts.

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';

import { CallButton } from '@/components/pbx/call-button';
import { useCalls } from '@/components/pbx/call-provider';
import { PresenceDot } from '@/components/presence/presence-dot';
import { useAuth } from '@/hooks/use-auth';
import { usePbxNames } from '@/hooks/use-pbx-names';
import { usePhonePresence } from '@/hooks/use-phone-presence';
import {
  colleagueRows,
  filterColleagues,
  type ExtensionRow,
} from '@/lib/pbx/colleagues';
import { PERSON_PRESENCE_KEY } from '@/lib/person-presence';
import { createClient } from '@/lib/supabase/client';

interface Loaded {
  key: string;
  rows: ExtensionRow[] | null;
}

export function Colleagues() {
  const t = useTranslations('CallsPage.colleagues');
  const tc = useTranslations('PbxCall');
  const tp = useTranslations('Presence');
  const tk = useTranslations('CallsPage.keypad');
  const { user, accountId } = useAuth();
  const me = useCalls()?.me ?? null;
  const names = usePbxNames();
  const phone = usePhonePresence();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // Only the caller's own phone system when they have an extension.
  const connectionId = me?.connectionId ?? null;
  const key = accountId ? `${accountId}:${connectionId ?? ''}` : null;
  useEffect(() => {
    if (!key || !accountId) return;
    let live = true;
    let q = supabase
      .from('pbx_extensions')
      .select('extension, user_id, presence_monitor, registration_state')
      .eq('account_id', accountId);
    if (connectionId) q = q.eq('connection_id', connectionId);
    void Promise.resolve(q).then(
      ({ data, error }) =>
        live &&
        setLoaded({
          key,
          rows: error ? null : ((data ?? []) as ExtensionRow[]),
        }),
      () => live && setLoaded({ key, rows: null })
    );
    return () => {
      live = false;
    };
  }, [supabase, key, accountId, connectionId]);

  const current = loaded?.key === key ? loaded : null;
  const rows = useMemo(
    () =>
      current?.rows
        ? colleagueRows({
            extensions: current.rows,
            names,
            phone,
            myUserId: user?.id ?? null,
            myExtension: me?.extension ?? null,
          })
        : [],
    [current, names, phone, user?.id, me?.extension]
  );
  const shown = filterColleagues(rows, query);

  if (!me)
    return <p className="text-muted-foreground text-sm">{tc('noExtension')}</p>;

  return (
    <div className="space-y-3">
      <label className="border-input bg-background flex h-10 max-w-sm items-center gap-2 rounded-lg border px-3">
        <Search className="text-muted-foreground size-4" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('search')}
          placeholder={t('search')}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      {!current ? (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      ) : current.rows === null ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('noMatch', { query: query.trim() })}
        </p>
      ) : (
        <ul className="border-border bg-card overflow-hidden rounded-xl border">
          {shown.map((r) => {
            const label = r.presence
              ? tp(PERSON_PRESENCE_KEY[r.presence])
              : null;
            return (
              <li
                key={r.extension}
                className="border-border flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
              >
                <span className="flex size-2.5 shrink-0 items-center justify-center">
                  {r.presence && label && (
                    <PresenceDot status={r.presence} label={label} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    {r.name ?? r.extension}
                    {r.mine && (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {t('you')}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-sm">
                    {[
                      r.name
                        ? t('extension', { extension: r.extension })
                        : null,
                      label,
                      r.unregistered ? t('unregistered') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {!r.mine && (
                  <CallButton
                    number={r.extension}
                    success={tk('ringing', { number: r.name ?? r.extension })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
