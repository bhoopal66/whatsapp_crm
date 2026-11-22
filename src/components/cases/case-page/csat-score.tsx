'use client';

/**
 * The case's customer ratings (CSAT, migration 246): one line per rating
 * request (after submission, after approval) with the score and comment,
 * or what the request is waiting on. Renders nothing while CSAT is off
 * for the workspace, while loading, on an error, or with no request yet.
 */
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Clock, MessageSquareText, Star } from 'lucide-react';

import type { CaseCsatItem } from '@/lib/cases/csat-http';

export function CsatScore({ caseId }: { caseId: string }) {
  const t = useTranslations('CaseCsat.score');
  const locale = useLocale();
  const [items, setItems] = useState<CaseCsatItem[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/cases/${encodeURIComponent(caseId)}/csat`)
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as {
          enabled?: boolean;
          items?: CaseCsatItem[];
        };
        return body.enabled ? (body.items ?? []) : null;
      })
      .catch(() => null)
      .then((list) => {
        if (live) setItems(list);
      });
    return () => {
      live = false;
    };
  }, [caseId]);

  if (!items || items.length === 0) return null;
  const when = (iso: string | null) =>
    iso && !Number.isNaN(new Date(iso).getTime())
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
          new Date(iso)
        )
      : null;

  return (
    <section className="bg-card rounded-lg border p-3">
      <h2 className="mb-2 text-sm font-semibold">{t('title')}</h2>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item.trigger} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {t(`trigger.${item.trigger}`)}
              </span>
              {item.score !== null ? (
                <span
                  className="inline-flex items-center gap-1"
                  aria-label={t('outOf', { score: item.score })}
                >
                  <span className="inline-flex" aria-hidden>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={
                          n <= item.score!
                            ? 'size-4 fill-amber-500 text-amber-600 dark:fill-amber-400 dark:text-amber-300'
                            : 'text-muted-foreground size-4'
                        }
                      />
                    ))}
                  </span>
                  <span>{t('outOf', { score: item.score })}</span>
                </span>
              ) : (
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  <Clock className="size-3.5" aria-hidden />
                  {t(`state.${item.state}`)}
                </span>
              )}
            </span>
            {item.comment && (
              <span className="text-muted-foreground flex items-start gap-1 text-xs">
                <MessageSquareText
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
                <span className="break-words">
                  {t('comment', { comment: item.comment })}
                </span>
              </span>
            )}
            {item.respondedAt
              ? when(item.respondedAt) && (
                  <span className="text-muted-foreground text-xs">
                    {t('ratedOn', { when: when(item.respondedAt)! })}
                  </span>
                )
              : item.askedAt &&
                when(item.askedAt) && (
                  <span className="text-muted-foreground text-xs">
                    {t('askedOn', { when: when(item.askedAt)! })}
                  </span>
                )}
          </li>
        ))}
      </ul>
    </section>
  );
}
