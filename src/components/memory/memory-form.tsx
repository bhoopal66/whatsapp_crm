'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  charCount,
  MEMORY_CONTENT_MAX,
  MEMORY_KINDS,
  saveErrorKey,
  type MemoryItemView,
  type MemoryKind,
} from '@/lib/memory/ui';

const IMPORTANCE = [1, 2, 3, 4, 5] as const;

/**
 * Add a memory, or correct one (prefilled; sends `supersedes`). Inline
 * rather than a dialog so it works at phone width.
 */
export function MemoryForm({
  apiBase,
  correcting,
  onDone,
  onCancel,
}: {
  apiBase: string;
  /** The item being corrected, else a new memory. */
  correcting: MemoryItemView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Memory');
  const [content, setContent] = useState(correcting?.content ?? '');
  const [kind, setKind] = useState<MemoryKind>(correcting?.kind ?? 'fact');
  const [importance, setImportance] = useState(correcting?.importance ?? 3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = charCount(content);
  const over = count > MEMORY_CONTENT_MAX;

  const save = async () => {
    if (!content.trim() || over) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          kind,
          importance,
          ...(correcting ? { supersedes: correcting.id } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        deduped?: unknown;
        code?: unknown;
      } | null;
      if (!res.ok) {
        setError(t(saveErrorKey(res.status, json?.code)));
        return;
      }
      toast.success(
        json?.deduped === true ? t('form.deduped') : t('form.saved')
      );
      onDone();
    } catch {
      setError(t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card space-y-3 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-semibold">
          {correcting ? t('form.correctTitle') : t('form.addTitle')}
        </h3>
        {correcting && (
          <p className="text-muted-foreground text-xs">
            {t('form.correctNote')}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="memory-content">{t('form.content')}</Label>
        <Textarea
          id="memory-content"
          value={content}
          rows={3}
          onChange={(e) => setContent(e.target.value)}
          aria-invalid={over || undefined}
          aria-describedby="memory-content-note"
        />
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
          <p id="memory-content-note" className="text-muted-foreground">
            {t('form.sensitiveNote')}
          </p>
          <span
            className={over ? 'text-destructive' : 'text-muted-foreground'}
            aria-live="polite"
          >
            {t('form.counter', { count, max: MEMORY_CONTENT_MAX })}
          </span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="memory-kind">{t('form.kind')}</Label>
          <Select
            value={kind}
            onValueChange={(v) => v && setKind(v as MemoryKind)}
          >
            <SelectTrigger id="memory-kind" className="w-full">
              <SelectValue>{t(`kinds.${kind}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MEMORY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kinds.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="memory-importance">{t('form.importance')}</Label>
          <Select
            value={String(importance)}
            onValueChange={(v) => v && setImportance(Number(v))}
          >
            <SelectTrigger id="memory-importance" className="w-full">
              <SelectValue>
                {t('form.importanceValue', { value: importance })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {IMPORTANCE.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('form.importanceValue', { value: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {t('form.cancel')}
        </Button>
        <Button
          type="button"
          disabled={busy || !content.trim() || over}
          onClick={() => void save()}
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {t('form.save')}
        </Button>
      </div>
    </div>
  );
}
