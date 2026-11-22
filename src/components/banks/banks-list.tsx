'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { LoadingState } from '@/components/dashboard/loading-state';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ExternalLink,
  Landmark,
  Plus,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';
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
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium';

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
    <div className="w-full space-y-4">
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
        <LoadingState />
      ) : loaded.error ? (
        <ErrorState message={t('loadFailed')} onRetry={() => void load()} />
      ) : loaded.workspaces.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title={t('emptyTitle')}
          hint={t('emptyBody')}
          className="rounded-xl py-12"
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {loaded.workspaces.map((w) => (
            <BankRow key={w.bankWsId} bankWsId={w.bankWsId}>
              <Link
                href={`/banks/${w.bankWsId}`}
                className="border-border bg-card hover:bg-accent flex items-start justify-between gap-2 rounded-xl border p-4 transition-colors"
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
                      ? 'bg-info-soft text-info'
                      : 'bg-muted text-foreground'
                  )}
                >
                  {t(`access.${w.access}`)}
                </span>
              </Link>
            </BankRow>
          ))}
        </ul>
      )}
    </div>
  );
}

function BankRow({
  bankWsId,
  children,
}: {
  bankWsId: string;
  children: ReactNode;
}) {
  const tMenu = useTranslations('ContextMenu');
  const router = useRouter();
  const itemRef = useRef<HTMLLIElement>(null);
  useContextMenuItems(itemRef, (): ContextMenuEntry[] => {
    const href = `/banks/${bankWsId}`;
    return [
      {
        id: 'open',
        label: tMenu('records.open'),
        icon: ExternalLink,
        onSelect: () => router.push(href),
      },
      {
        id: 'openNewTab',
        label: tMenu('records.openNewTab'),
        icon: SquareArrowOutUpRight,
        onSelect: () => void window.open(href, '_blank', 'noopener,noreferrer'),
      },
    ];
  });
  return <li ref={itemRef}>{children}</li>;
}
