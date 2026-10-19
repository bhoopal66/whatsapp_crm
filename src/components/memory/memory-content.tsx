'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  memorySegments,
  REVEAL_REASON_MAX,
  REVEAL_VISIBLE_MS,
  revealErrorKey,
  type MemorySegment,
  type VaultTokenKind,
} from '@/lib/memory/ui';

const CHIP =
  'mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-px align-baseline text-xs';

/**
 * One memory's content as segments: text stays text (never HTML), a
 * vault token is a chip (a button for a vault role), a redaction marker
 * a muted chip.
 */
export function MemoryContent({
  content,
  canReveal,
}: {
  content: string;
  canReveal: boolean;
}) {
  const t = useTranslations('Memory');
  const [open, setOpen] = useState<{
    token: string;
    kind: VaultTokenKind;
  } | null>(null);

  const piece = (s: MemorySegment, i: number) => {
    if (s.type === 'text') return <span key={i}>{s.text}</span>;
    if (s.type === 'redaction') {
      const label =
        s.kind === 'PHONE' && s.last
          ? t('chips.redacted.phoneEnding', { digits: s.last })
          : t(`chips.redacted.${s.kind}`);
      return (
        <span
          key={i}
          className={`${CHIP} bg-muted text-muted-foreground border-transparent`}
        >
          {label}
        </span>
      );
    }
    const label = t(`chips.${s.kind}`);
    if (!canReveal)
      return (
        <span
          key={i}
          className={`${CHIP} bg-secondary text-secondary-foreground`}
          title={t('chips.vaulted', { label })}
        >
          <Lock className="size-3" aria-hidden />
          {label}
        </span>
      );
    return (
      <button
        key={i}
        type="button"
        className={`${CHIP} bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none`}
        aria-label={t('chips.revealHint', { label })}
        onClick={() => setOpen({ token: s.token, kind: s.kind })}
      >
        <Lock className="size-3" aria-hidden />
        {label}
      </button>
    );
  };

  return (
    <>
      <p className="break-words whitespace-pre-wrap">
        {memorySegments(content).map(piece)}
      </p>
      {/* Mounted only while open: closing it drops the value with it. */}
      {open && (
        <RevealDialog
          token={open.token}
          label={t(`chips.${open.kind}`)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * Asks for a reason, reveals one vaulted value and shows it for 30
 * seconds. The value lives only in this component's state: never cached,
 * never stored, gone when the timer runs out or the dialog closes.
 */
function RevealDialog({
  token,
  label,
  onClose,
}: {
  token: string;
  label: string;
  onClose: () => void;
}) {
  const t = useTranslations('Memory');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (value === null) return;
    const until = Date.now() + REVEAL_VISIBLE_MS;
    const timer = setInterval(() => {
      const ms = until - Date.now();
      if (ms <= 0) {
        setValue(null);
        setHidden(true);
      } else setLeft(Math.ceil(ms / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [value]);

  const trimmed = reason.trim();
  const tooLong = [...reason].length > REVEAL_REASON_MAX;

  const reveal = async () => {
    if (!trimmed || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/vault/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token, reason }),
      });
      const json = (await res.json().catch(() => null)) as {
        value?: unknown;
        code?: unknown;
      } | null;
      if (res.ok && typeof json?.value === 'string') {
        setHidden(false);
        setLeft(Math.ceil(REVEAL_VISIBLE_MS / 1000));
        setValue(json.value);
      } else
        setError(t(`reveal.errors.${revealErrorKey(res.status, json?.code)}`));
    } catch {
      setError(t('reveal.errors.failed'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('reveal.copied'));
    } catch {
      toast.error(t('reveal.copyFailed'));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('reveal.title', { label })}</DialogTitle>
          <DialogDescription>{t('reveal.body')}</DialogDescription>
        </DialogHeader>

        {value !== null ? (
          <div className="space-y-2">
            <div className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2">
              <span className="min-w-0 flex-1 font-mono text-sm break-all select-all">
                {value}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copy()}
              >
                <Copy className="size-3.5" aria-hidden />
                {t('reveal.copy')}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs" role="status">
              {t('reveal.hidesIn', { seconds: left })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {hidden && (
              <p className="text-muted-foreground text-xs" role="status">
                {t('reveal.hidden')}
              </p>
            )}
            <Label htmlFor="memory-reveal-reason">{t('reveal.reason')}</Label>
            <Textarea
              id="memory-reveal-reason"
              value={reason}
              rows={2}
              placeholder={t('reveal.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={tooLong || undefined}
            />
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {t('reveal.cancel')}
          </Button>
          {value === null && (
            <Button
              type="button"
              disabled={busy || !trimmed || tooLong}
              onClick={() => void reveal()}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('reveal.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
