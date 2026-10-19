'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/** A tab's GET, fetched on mount; a failed refresh keeps what is shown. */
export function useCaseResource<T>(
  url: string,
  parse: (json: unknown) => T
): {
  data: T | null;
  failed: boolean;
  /** When the shown data was fetched (epoch ms; 0 before the first). */
  loadedAt: number;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const parseRef = useRef(parse);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const parsed = parseRef.current(await res.json());
      if (!mounted.current) return;
      setData(parsed);
      setLoadedAt(Date.now());
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return { data, failed, loadedAt, reload };
}

/** Loading / load-failed placeholder for a tab with nothing to show yet. */
export function TabStatus({
  failed,
  loading,
  error,
  onRetry,
}: {
  failed: boolean;
  loading: string;
  error: string;
  onRetry: () => void;
}) {
  const t = useTranslations('CasePage');
  if (!failed)
    return (
      <p
        className="text-muted-foreground py-8 text-center text-sm"
        aria-busy="true"
      >
        {loading}
      </p>
    );
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-sm">
      <p className="text-muted-foreground">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

/** Medium date + short time in the page locale; null for none/invalid. */
export function useWhen(): (iso: string | null) => string | null {
  const locale = useLocale();
  return (iso) =>
    iso && !Number.isNaN(new Date(iso).getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : null;
}

type Obj = Record<string, unknown>;
export const asObj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
export const asStr = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
