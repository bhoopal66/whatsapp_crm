'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  macroErrorKey,
  parseApplyResult,
  parseMacros,
  summariseApplyResult,
  type CaseMacroView,
  type ResultLine,
} from '@/lib/cases/macros-ui';

import { sendCaseRequest } from './case-dialogs';

interface Shown {
  name: string;
  lines: ResultLine[];
  preview: string | null;
}

/** "Apply macro" in the case header: pick a saved macro, see what ran. */
export function ApplyMacroMenu({
  caseId,
  disabled,
  onApplied,
}: {
  caseId: string;
  disabled?: boolean;
  onApplied: () => void;
}) {
  const t = useTranslations('CaseMacros');
  const [menuOpen, setMenuOpen] = useState(false);
  const [macros, setMacros] = useState<CaseMacroView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);

  async function load() {
    setLoadFailed(false);
    try {
      const res = await fetch('/api/cases/macros', { cache: 'no-store' });
      const list = res.ok ? parseMacros(await res.json()) : null;
      if (list) setMacros(list);
      else setLoadFailed(true);
    } catch {
      setLoadFailed(true);
    }
  }

  function onMenuOpenChange(o: boolean) {
    setMenuOpen(o);
    if (o) void load();
  }

  async function apply(m: CaseMacroView) {
    if (applying) return;
    setApplying(true);
    try {
      const r = await sendCaseRequest(
        `/api/cases/${caseId}/macros/${m.id}/apply`,
        'POST'
      );
      const result = r.ok ? parseApplyResult(r.json) : null;
      if (!result) {
        const code = (r.json as { code?: unknown } | null)?.code;
        toast.error(t(`errors.${macroErrorKey(r.status, code)}`));
        return;
      }
      setShown({
        name: m.name,
        lines: summariseApplyResult(result, m.actions),
        preview: result.documentRequestPreview,
      });
      onApplied();
    } finally {
      setApplying(false);
    }
  }

  function lineText(l: ResultLine): string {
    switch (l.key) {
      case 'stageMoved':
        return t('lines.stageMoved', { stage: l.stage });
      case 'stopped':
        return t('lines.stopped', { step: l.step, reason: l.reason });
      default:
        return t(`lines.${l.key}`);
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={disabled || applying}
            />
          }
        >
          {applying ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Wand2 className="size-4" aria-hidden />
          )}
          {applying ? t('apply.applying') : t('apply.button')}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-72 min-w-56 overflow-y-auto"
        >
          {loadFailed ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">
              {t('apply.loadFailed')}
            </p>
          ) : macros === null ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
            </p>
          ) : macros.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">
              {t('apply.empty')}
            </p>
          ) : (
            macros.map((m) => (
              <DropdownMenuItem key={m.id} onClick={() => void apply(m)}>
                {m.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={shown !== null} onOpenChange={(o) => !o && setShown(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('apply.resultTitle', { name: shown?.name ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {shown?.lines.map((l, i) => (
              <li key={i}>{lineText(l)}</li>
            ))}
          </ul>
          {shown?.preview && (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('apply.previewTitle')}</p>
              <p className="bg-card-2 rounded-md border p-2 text-sm whitespace-pre-wrap">
                {shown.preview}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('apply.previewHint')}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShown(null)}>
              {t('apply.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
