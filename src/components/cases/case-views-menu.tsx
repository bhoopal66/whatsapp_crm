'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AtSign,
  BellRing,
  Bookmark,
  ChevronDown,
  Clock,
  Loader2,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  EMPTY_FILTERS,
  filtersToSearch,
  SNOOZED_MODES,
  type InboxFilters,
  type InboxRow,
  type InboxSnoozed,
} from '@/lib/cases/ui';
import {
  inboxFiltersFromView,
  parseViews,
  viewFiltersFromInbox,
  viewSortFromInbox,
  type SavedView,
} from '@/lib/cases/views-ui';
import { cn } from '@/lib/utils';

/** Refusal codes the views routes answer with; anything else is generic. */
const KNOWN_ERRORS = [
  'NAME_INVALID',
  'FILTER_INVALID',
  'NOT_ALLOWED',
  'VIEW_NOT_FOUND',
] as const;
type ViewError = (typeof KNOWN_ERRORS)[number] | 'FAILED';

async function errorCode(res: Response): Promise<ViewError> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      const nested =
        typeof b.error === 'object' && b.error !== null
          ? (b.error as Record<string, unknown>).code
          : null;
      for (const c of [b.code, b.error, nested])
        if (
          typeof c === 'string' &&
          (KNOWN_ERRORS as readonly string[]).includes(c)
        )
          return c as ViewError;
    }
  } catch {
    // Not JSON: generic.
  }
  return 'FAILED';
}

/** The "Views" menu: All cases, shared views, my views, save, delete. */
export function CaseViewsMenu({
  filters,
  setFilters,
}: {
  filters: InboxFilters;
  setFilters: (next: InboxFilters) => void;
}) {
  const t = useTranslations('CaseViews');
  const { user } = useAuth();
  const canShare = useCan('edit-settings');
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<ViewError | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<SavedView | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/cases/views', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setViews(parseViews(await res.json()));
    } catch {
      setViews([]);
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/cases/views', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const parsed = parseViews(await res.json());
        if (live) setViews(parsed);
      } catch {
        // No views listed; the menu still offers All cases and Save.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const me = user?.id ?? null;
  const shared = views.filter((v) => v.shared);
  const mine = views.filter((v) => !v.shared && v.ownerUserId === me);
  const current = filtersToSearch(filters);
  const active = views.find(
    (v) => filtersToSearch(inboxFiltersFromView(v)) === current
  );
  const canDelete = (v: SavedView) => v.ownerUserId === me || canShare;

  const item = (v: SavedView) => (
    <DropdownMenuItem
      key={v.viewId}
      onClick={() => {
        setError(null);
        setFilters(inboxFiltersFromView(v));
      }}
      className={cn(active?.viewId === v.viewId && 'font-semibold')}
    >
      <span className="min-w-0 flex-1 truncate">{v.name}</span>
      {canDelete(v) && (
        <button
          type="button"
          aria-label={t('deleteView', { name: v.name })}
          className="text-muted-foreground hover:text-destructive rounded p-0.5"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setDeleting(v);
          }}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </DropdownMenuItem>
  );

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {t(`errors.${error}`)}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="outline" size="sm" />}
        >
          <Bookmark className="size-4" aria-hidden />
          <span className="max-w-40 truncate">
            {active ? active.name : t('views')}
          </span>
          <ChevronDown className="size-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            onClick={() => {
              setError(null);
              setFilters(EMPTY_FILTERS);
            }}
          >
            {t('allCases')}
          </DropdownMenuItem>
          {shared.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('sharedViews')}</DropdownMenuLabel>
                {shared.map(item)}
              </DropdownMenuGroup>
            </>
          )}
          {mine.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('myViews')}</DropdownMenuLabel>
                {mine.map(item)}
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSaving(true)}>
            {t('saveCurrent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {saving && (
        <SaveViewDialog
          filters={filters}
          canShare={canShare}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            void reload();
          }}
        />
      )}
      {deleting && (
        <DeleteViewDialog
          view={deleting}
          onClose={() => setDeleting(null)}
          onDone={(err) => {
            setDeleting(null);
            setError(err);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function SaveViewDialog({
  filters,
  canShare,
  onClose,
  onSaved,
}: {
  filters: InboxFilters;
  canShare: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('CaseViews');
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ViewError | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError('NAME_INVALID');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/cases/views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          filters: viewFiltersFromInbox(filters),
          sort: viewSortFromInbox(filters),
          shared: canShare && share,
        }),
      });
      if (!res.ok) {
        setError(await errorCode(res));
        return;
      }
      onSaved();
    } catch {
      setError('FAILED');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('saveTitle')}</DialogTitle>
          <DialogDescription>{t('saveBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="case-view-name">{t('name')}</Label>
          <Input
            id="case-view-name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save();
            }}
          />
        </div>
        {canShare && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="case-view-share"
              checked={share}
              onCheckedChange={(v) => setShare(!!v)}
            />
            <Label htmlFor="case-view-share" className="text-sm font-normal">
              {t('shareWithTeam')}
            </Label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t(`errors.${error}`)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteViewDialog({
  view,
  onClose,
  onDone,
}: {
  view: SavedView;
  onClose: () => void;
  onDone: (error: ViewError | null) => void;
}) {
  const t = useTranslations('CaseViews');
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/cases/views/${encodeURIComponent(view.viewId)}`,
        { method: 'DELETE' }
      );
      onDone(res.ok ? null : await errorCode(res));
    } catch {
      onDone('FAILED');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteTitle', { name: view.name })}</DialogTitle>
          <DialogDescription>
            {view.shared ? t('deleteSharedBody') : t('deleteBody')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t('delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hide (default) · Only · All, for `filters.snoozed`. */
export function SnoozedControl({
  value,
  onChange,
}: {
  value: InboxSnoozed;
  onChange: (v: InboxSnoozed) => void;
}) {
  const t = useTranslations('CaseViews');
  return (
    <div className="flex items-center gap-2">
      <span id="cases-snoozed-label" className="text-sm">
        {t('snoozed')}
      </span>
      <div
        role="group"
        aria-labelledby="cases-snoozed-label"
        className="border-input bg-card-2 inline-flex rounded-lg border p-0.5"
      >
        {SNOOZED_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value === m}
            onClick={() => onChange(m)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              value === m
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`snoozedModes.${m}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The "Mentions me" filter chip. */
export function MentionsChip({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTranslations('CaseViews');
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-card-2 text-muted-foreground hover:text-foreground'
      )}
    >
      <AtSign className="size-3.5" aria-hidden />
      {t('mentionsMe')}
    </button>
  );
}

/** A row's snooze chip: until a future date, or back from snooze. */
export function SnoozeChip({
  row,
  now,
  className,
}: {
  row: Pick<InboxRow, 'snoozedUntil' | 'snoozeExpired'>;
  now: Date;
  className: string;
}) {
  const t = useTranslations('CaseViews');
  const locale = useLocale();
  if (row.snoozeExpired)
    return (
      <span className={cn(className, 'bg-info-soft text-info gap-1')}>
        <BellRing className="size-3" aria-hidden />
        {t('backFromSnooze')}
      </span>
    );
  if (!row.snoozedUntil) return null;
  const until = new Date(row.snoozedUntil);
  if (Number.isNaN(until.getTime()) || until <= now) return null;
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(until);
  return (
    <span className={cn(className, 'bg-muted text-muted-foreground gap-1')}>
      <Clock className="size-3" aria-hidden />
      {t('snoozedUntil', { date })}
    </span>
  );
}
