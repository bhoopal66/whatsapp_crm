'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AtSign, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { stageChipClass } from '@/lib/cases/ui';
import {
  mentionPreview,
  parseMentions,
  type MentionItem,
} from '@/lib/cases/views-ui';
import { relativeActivity } from '@/lib/groups/ui';
import { cn } from '@/lib/utils';

const PAGE = 20;

/** "Mentions": the case notes that mention the signed-in person. */
export function CaseMentionsButton() {
  const t = useTranslations('CaseViews');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // A plain fetch each time the sheet opens or pages: never cached.
  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (after) qs.set('after', after);
      const res = await fetch(`/api/cases/mentions?${qs}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseMentions(await res.json());
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setNext(page.next);
      setLoaded(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setItems([]);
      setNext(null);
      setLoaded(false);
      void load(null);
    }
  };

  const when = (iso: string | null, now: Date): string | null => {
    const a = relativeActivity(iso, now);
    if (a.unit === 'none') return null;
    if (a.unit === 'now') return t('mentionsJustNow');
    if (a.unit === 'date')
      return a.date.toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
        year:
          a.date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      });
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      -a.value,
      a.unit
    );
  };
  const now = new Date();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onOpenChange(true)}
      >
        <AtSign className="size-4" aria-hidden />
        {t('mentions')}
      </Button>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('mentions')}</SheetTitle>
            <SheetDescription>{t('mentionsBody')}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
            {items.map((m) => {
              const author = m.authorId
                ? (nameOf(m.authorId) ?? t('mentionsAutomatic'))
                : t('mentionsAutomatic');
              const time = when(m.createdAt, now);
              return (
                <Link
                  key={m.noteId}
                  href={`/cases/${m.caseId}`}
                  className="border-border bg-card hover:bg-card-2 block rounded-lg border p-3 text-sm transition-colors"
                  onClick={() => setOpen(false)}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
                        stageChipClass(m.stage)
                      )}
                    >
                      {m.stage ?? t('mentionsNoStage')}
                    </span>
                    <span className="text-muted-foreground min-w-0 truncate">
                      {author}
                    </span>
                    {time && (
                      <span className="text-muted-foreground ms-auto shrink-0">
                        {time}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 break-words">{mentionPreview(m.body)}</p>
                </Link>
              );
            })}
            {loading && (
              <div className="text-muted-foreground flex justify-center py-3">
                <Loader2 className="size-4 animate-spin" aria-hidden />
              </div>
            )}
            {failed && (
              <div role="alert" className="space-y-2 py-3 text-center text-sm">
                <p className="text-destructive">{t('mentionsError')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void load(items.length > 0 ? next : null)}
                >
                  {t('mentionsRetry')}
                </Button>
              </div>
            )}
            {loaded && !loading && !failed && items.length === 0 && (
              <p className="text-muted-foreground py-6 text-center text-sm">
                {t('mentionsEmpty')}
              </p>
            )}
            {next && !loading && !failed && (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void load(next)}
                >
                  {t('mentionsMore')}
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
