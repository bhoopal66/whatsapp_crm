'use client';

/**
 * The second brain's Daily digest page (package 022e): the caller's four
 * sections (stale cases, promises, related closed cases, follow-ups),
 * each item linking to its case with the reason. A list only: nothing
 * here changes data or contacts a customer. Owners and admins get a
 * "View as" teammate picker (`?userId=`), a view filter the route
 * re-checks. Only `@/lib/brain/ui` and `@/lib/brain/digest-view` may be
 * imported from here: the rest of lib/brain is server code.
 */

import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import {
  type DigestView,
  digestItemHref,
  digestUrl,
  parseDigest,
  viewAsOptions,
} from '@/lib/brain/digest-view';
import { isBrainDisabled } from '@/lib/brain/ui';

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'disabled' }
  | { state: 'ready'; view: DigestView };

export function DailyDigest() {
  const t = useTranslations('Brain.digest');
  const tb = useTranslations('Brain');
  const format = useFormatter();
  const { isAdmin, user } = useAuth();
  const { members } = useWorkspaceMembers();
  const [viewAs, setViewAs] = useState('');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const req = useRef(0);
  const options = useMemo(
    () => (isAdmin ? viewAsOptions(members, user?.id) : []),
    [isAdmin, members, user?.id]
  );

  useEffect(() => {
    const id = ++req.current;
    (async () => {
      setLoad({ state: 'loading' });
      try {
        const res = await fetch(digestUrl(viewAs));
        const body: unknown = await res.json().catch(() => null);
        if (id !== req.current) return;
        if (isBrainDisabled(res.status, body)) {
          setLoad({ state: 'disabled' });
          return;
        }
        const view = res.ok ? parseDigest(body) : null;
        setLoad(view ? { state: 'ready', view } : { state: 'failed' });
      } catch {
        if (id === req.current) setLoad({ state: 'failed' });
      }
    })();
  }, [viewAs]);

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <p className="text-muted-foreground text-sm" role="note">
          {t('banner')}
        </p>
      </div>
      {isAdmin && load.state !== 'disabled' ? (
        <label className="flex items-center gap-2 text-sm">
          <span>{t('viewAs')}</span>
          <select
            className="border-input bg-card dark:bg-input/30 h-9 rounded-md border px-2 text-sm"
            value={viewAs}
            onChange={(e) => setViewAs(e.target.value)}
          >
            <option value="">{t('me')}</option>
            {options.map((o) => (
              <option key={o.userId} value={o.userId}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );

  let body: ReactNode;
  if (load.state === 'disabled') {
    body = (
      <Card>
        <CardContent>
          <p className="text-muted-foreground text-sm" role="status">
            {tb('disabled')}
          </p>
        </CardContent>
      </Card>
    );
  } else if (load.state === 'loading') {
    body = (
      <p className="text-muted-foreground text-sm" role="status">
        {t('loading')}
      </p>
    );
  } else if (load.state === 'failed') {
    body = (
      <p className="text-destructive text-sm" role="alert">
        {t('failed')}
      </p>
    );
  } else {
    const { view } = load;
    body = (
      <>
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          {view.aiGenerated ? (
            <Badge variant="outline">{tb('ai')}</Badge>
          ) : null}
          {t('generated', {
            when: format.dateTime(new Date(view.generatedAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
        {view.sections.map((s) => (
          <Card key={s.kind} size="sm">
            <CardHeader>
              <CardTitle>{t(`sections.${s.kind}`)}</CardTitle>
            </CardHeader>
            <CardContent>
              {s.items.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {s.items.map((it, n) => (
                    <li
                      key={`${it.caseId}:${it.citation?.id ?? ''}:${n}`}
                      className="bg-card-2 rounded-md px-3 py-2 text-sm"
                    >
                      <Link
                        href={digestItemHref(it.caseId)}
                        className="text-primary font-medium underline"
                      >
                        {it.label}
                      </Link>
                      <p className="text-muted-foreground break-words">
                        {it.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      {header}
      {body}
    </div>
  );
}
