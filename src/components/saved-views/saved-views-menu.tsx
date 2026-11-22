'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BookmarkPlus,
  Check,
  Loader2,
  Trash2,
  Users,
  User,
  Bookmark,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { canEditSettings, canShareSavedViews } from '@/lib/auth/roles';
import {
  canChangeView,
  cleanViewName,
  sortViews,
  type SavedView,
  type ViewScreen,
} from '@/lib/saved-views/types';
import {
  createView,
  deleteView,
  listViews,
  updateView,
} from '@/lib/saved-views/store';

/**
 * "Views" button for a screen with filters. The screen passes the filters
 * it has now (`current`, a plain JSON object it can read back) and applies
 * a chosen view's filters itself (`onApply`); this component owns the
 * list, saving, sharing and deleting. Who may do what is RLS (250), this
 * only hides what would be refused.
 */
export function SavedViewsMenu({
  screen,
  current,
  hasFilters,
  onApply,
  triggerClassName,
}: {
  screen: ViewScreen;
  current: Record<string, unknown>;
  /** Nothing to save while the screen is unfiltered. */
  hasFilters: boolean;
  onApply: (filters: Record<string, unknown>) => void;
  triggerClassName?: string;
}) {
  const t = useTranslations('SavedViews');
  const { user, accountId, accountRole } = useAuth();
  const me = user?.id ?? null;
  const mayShare = accountRole ? canShareSavedViews(accountRole) : false;
  const isAdmin = accountRole ? canEditSettings(accountRole) : false;

  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setViews(await listViews(createClient(), screen));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [screen]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    const clean = cleanViewName(name);
    if (!clean) {
      toast.error(t('nameInvalid'));
      return;
    }
    if (!me || !accountId) return;
    setBusy(true);
    try {
      const view = await createView(createClient(), {
        accountId,
        userId: me,
        screen,
        name: clean,
        filters: current,
        shared: shared && mayShare,
      });
      setName('');
      setShared(false);
      setActiveId(view.id);
      toast.success(t('saved'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function update(view: SavedView) {
    setBusy(true);
    try {
      await updateView(createClient(), view.id, { filters: current });
      toast.success(t('updated'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(view: SavedView) {
    setBusy(true);
    try {
      await deleteView(createClient(), view.id);
      if (activeId === view.id) setActiveId(null);
      toast.success(t('deleted'));
      await load();
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  const sorted = views ? sortViews(views, me) : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className={cn(
              'border-border text-muted-foreground hover:bg-muted shrink-0',
              triggerClassName
            )}
          />
        }
      >
        <Bookmark className="size-4" />
        {t('button')}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="border-border border-b px-3 py-2">
          <span className="text-popover-foreground text-sm font-medium">
            {t('title')}
          </span>
        </div>

        <div className="max-h-64 overflow-y-auto p-1">
          {views === null && !failed ? (
            <div className="flex justify-center p-4">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : failed ? (
            <p className="text-destructive p-3 text-sm">{t('loadFailed')}</p>
          ) : sorted.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">{t('empty')}</p>
          ) : (
            sorted.map((view) => {
              const changeable = canChangeView(view, me, isAdmin);
              return (
                <div
                  key={view.id}
                  className="hover:bg-muted flex items-center gap-1 rounded-md pe-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(view.id);
                      onApply(view.filters);
                      setOpen(false);
                    }}
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 text-start text-sm"
                  >
                    {activeId === view.id ? (
                      <Check className="text-primary size-4 shrink-0" />
                    ) : view.shared ? (
                      <Users className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <User className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="truncate">{view.name}</span>
                    <span className="text-muted-foreground ms-auto shrink-0 text-xs">
                      {view.shared ? t('sharedTag') : t('personalTag')}
                    </span>
                  </button>
                  {changeable ? (
                    <>
                      {hasFilters ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void update(view)}
                          title={t('replaceHint')}
                        >
                          {t('replace')}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={t('delete', { name: view.name })}
                        onClick={() => void remove(view)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="border-border space-y-2 border-t p-3">
          {hasFilters ? (
            <>
              <Input
                value={name}
                maxLength={60}
                placeholder={t('namePlaceholder')}
                aria-label={t('namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
              />
              {mayShare ? (
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`share-view-${screen}`} className="text-sm">
                    {t('shareWithTeam')}
                  </Label>
                  <Switch
                    id={`share-view-${screen}`}
                    checked={shared}
                    onCheckedChange={setShared}
                  />
                </div>
              ) : null}
              <Button
                className="w-full"
                disabled={busy || !name.trim()}
                onClick={() => void save()}
              >
                <BookmarkPlus className="size-4" />
                {t('saveCurrent')}
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('pickFiltersFirst')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
