'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Landmark, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  errorKey,
  parseBankList,
  type BankSpace,
  type CreatableBank,
} from '@/lib/banks/ui';
import { cn } from '@/lib/utils';

export const chip =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium';

interface Loaded {
  workspaces: BankSpace[];
  creatable: CreatableBank[];
  error: boolean;
}

/** /banks — the bank workspaces of the active account (module 019). */
export function BanksList() {
  const t = useTranslations('Banks');
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [opening, setOpening] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoaded(null);
    try {
      const res = await fetch('/api/banks', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const list = parseBankList(await res.json());
      if (mine === seq.current) setLoaded({ ...list, error: false });
    } catch {
      if (mine === seq.current)
        setLoaded({ workspaces: [], creatable: [], error: true });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (code: string) => {
    setOpening(true);
    try {
      const res = await fetch('/api/banks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_code: code }),
      });
      const json: unknown = await res.json().catch(() => null);
      const id =
        res.ok && json && typeof json === 'object' && 'id' in json
          ? String((json as { id: unknown }).id)
          : null;
      if (!id) {
        toast.error(t(`errors.${errorKey(res.status, json)}`));
        return;
      }
      router.push(`/banks/${id}`);
    } catch {
      toast.error(t('errors.failed'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {loaded && loaded.creatable.length > 0 && (
          <Select
            value=""
            disabled={opening}
            onValueChange={(v) => {
              if (typeof v === 'string' && v) void open(v);
            }}
          >
            <SelectTrigger
              aria-label={t('openSpace')}
              className="w-full sm:w-56"
            >
              <Plus className="size-4" aria-hidden />
              <SelectValue>
                {opening ? t('opening') : t('openSpace')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {loaded.creatable.map((b) => (
                <SelectItem key={b.code} value={b.code}>
                  {b.name} ({b.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {!loaded ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="border-border bg-card h-20 animate-pulse rounded-xl border"
            />
          ))}
        </ul>
      ) : loaded.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : loaded.workspaces.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <Landmark className="size-5" aria-hidden />
          </span>
          <p className="font-semibold">{t('emptyTitle')}</p>
          <p className="text-muted-foreground max-w-md text-sm">
            {t('emptyBody')}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {loaded.workspaces.map((w) => (
            <li key={w.bankWsId}>
              <Link
                href={`/banks/${w.bankWsId}`}
                className="border-border bg-card hover:bg-muted/60 flex items-start justify-between gap-2 rounded-xl border p-4 transition-colors"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {w.bankName}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {w.bankCode}
                  </span>
                </span>
                <span
                  className={cn(
                    chip,
                    w.access === 'admin'
                      ? 'bg-sky-500/15 text-sky-700 [[data-mode=dark]_&]:text-sky-300'
                      : 'bg-muted text-foreground'
                  )}
                >
                  {t(`access.${w.access}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
