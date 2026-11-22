'use client';

/**
 * File preview while sorting (U5, migration 248). Self-contained: given
 * an intake item or a tray item, it asks the server for a short-lived
 * link (`/api/desk/{intake,tray}/[id]/preview`, 300 s), then shows an
 * image, a PDF in a frame, or, for anything else, an "Open in new tab"
 * link. The link is held in memory only and fetched again once it
 * expires; it is never logged or stored.
 *
 * `PreviewBeside` lays a preview next to a panel: stacked on a phone,
 * side by side from `lg` up.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ExternalLink,
  FileQuestion,
  Loader2,
  RotateCw,
} from 'lucide-react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  msUntilExpiry,
  parsePreviewLink,
  previewErrorKey,
  previewKind,
  previewRoute,
  type PreviewErrorKey,
  type PreviewLink,
  type PreviewTarget,
} from '@/lib/desk/preview';
import { cn } from '@/lib/utils';

type State =
  | { at: 'idle' }
  | { at: 'loading' }
  | { at: 'ready'; link: PreviewLink }
  | { at: 'expired' }
  | { at: 'error'; key: PreviewErrorKey };

export function FilePreview({
  target,
  mime,
  name,
  autoLoad = false,
  className,
}: {
  target: PreviewTarget;
  mime: string | null;
  name: string | null;
  /** Fetch the link at once (the sort panel); else on a button press. */
  autoLoad?: boolean;
  className?: string;
}) {
  const t = useTranslations('DeskPreview');
  // Each item renders its own preview, so the target never changes under
  // one instance; with autoLoad the first fetch starts on mount.
  const [state, setState] = useState<State>(
    autoLoad ? { at: 'loading' } : { at: 'idle' }
  );
  const [broken, setBroken] = useState(false);
  // The answer of an older request (a second press, an unmount) is
  // dropped rather than shown.
  const seq = useRef(0);
  const route = previewRoute(target);

  const fetchLink = useCallback(async (): Promise<State> => {
    try {
      const res = await fetch(route, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as unknown;
      const link = res.ok ? parsePreviewLink(body) : null;
      if (link) return { at: 'ready', link };
      const code =
        body && typeof body === 'object' && 'code' in body
          ? String((body as { code: unknown }).code)
          : null;
      return { at: 'error', key: previewErrorKey(res.status, code) };
    } catch {
      return { at: 'error', key: 'generic' };
    }
  }, [route]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setBroken(false);
    setState({ at: 'loading' });
    const next = await fetchLink();
    if (mine === seq.current) setState(next);
  }, [fetchLink]);

  useEffect(() => {
    if (!autoLoad) return;
    let live = true;
    const mine = ++seq.current;
    void fetchLink().then((next) => {
      if (live && mine === seq.current) setState(next);
    });
    return () => {
      live = false;
    };
  }, [autoLoad, fetchLink]);

  // A signed link stops working after 300 s: say so rather than show a
  // frame that breaks on its next request.
  const expiresAt = state.at === 'ready' ? state.link.expiresAt : null;
  useEffect(() => {
    const ms = msUntilExpiry(expiresAt, Date.now());
    if (ms === null) return;
    const timer = setTimeout(() => setState({ at: 'expired' }), ms);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const label = name?.trim() || t('unnamed');
  const kind = state.at === 'ready' ? state.link.kind : previewKind(mime, name);

  return (
    <section
      aria-label={t('title', { name: label })}
      className={cn(
        'bg-card-2 min-w-0 space-y-2 rounded-lg border p-2',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-foreground min-w-0 truncate text-sm font-medium">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {state.at === 'ready' && (
            <a
              href={state.link.url}
              target="_blank"
              rel="noreferrer noopener"
              referrerPolicy="no-referrer"
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              <ExternalLink aria-hidden className="size-3.5" />
              {t('openNewTab')}
            </a>
          )}
          {(state.at === 'idle' ||
            state.at === 'error' ||
            state.at === 'expired') && (
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {state.at === 'idle' ? null : (
                <RotateCw aria-hidden className="size-3.5" />
              )}
              {state.at === 'idle' ? t('show') : t('reload')}
            </Button>
          )}
        </div>
      </div>

      {state.at === 'loading' && (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm"
        >
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t('loading')}
        </p>
      )}

      {state.at === 'error' && (
        <p
          role="alert"
          className="bg-destructive-soft text-destructive flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{t('errorWord')}</span>{' '}
            {t(`errors.${state.key}`)}
          </span>
        </p>
      )}

      {state.at === 'expired' && (
        <p
          role="status"
          className="bg-warning-soft text-warning flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{t('expired')}</span>
        </p>
      )}

      {state.at === 'ready' && broken && (
        <p
          role="alert"
          className="bg-destructive-soft text-destructive flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{t('errorWord')}</span>{' '}
            {t('errors.broken')}
          </span>
        </p>
      )}

      {state.at === 'ready' && !broken && kind === 'image' && (
        // A short-lived signed URL: next/image would cache and resize it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={state.link.url}
          alt={t('imageAlt', { name: label })}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="bg-card mx-auto block max-h-[70vh] w-full rounded-md object-contain"
        />
      )}

      {state.at === 'ready' && !broken && kind === 'pdf' && (
        <iframe
          src={state.link.url}
          title={t('frameTitle', { name: label })}
          referrerPolicy="no-referrer"
          className="bg-card block h-[28rem] w-full rounded-md border-0 lg:h-[70vh]"
        />
      )}

      {state.at === 'ready' && kind === 'other' && (
        <EmptyState
          icon={FileQuestion}
          title={t('other.title')}
          hint={t('other.hint')}
          className="min-h-32"
        />
      )}
    </section>
  );
}

/** A preview beside a panel: stacked on a phone, side by side on `lg`. */
export function PreviewBeside({
  preview,
  children,
}: {
  preview: ReactNode;
  children: ReactNode;
}) {
  if (!preview) return <>{children}</>;
  return (
    <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
      <div className="min-w-0 lg:sticky lg:top-2">{preview}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
