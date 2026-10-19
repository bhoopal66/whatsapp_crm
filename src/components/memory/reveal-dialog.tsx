'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Loader2 } from 'lucide-react';
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
  REVEAL_REASON_MAX,
  REVEAL_VISIBLE_MS,
  revealErrorKey,
} from '@/lib/memory/ui';
import { reasonLooksLikeIdentifier } from '@/lib/vault/ui';

/**
 * The vault reveal pieces shared by Memory's token chips and Settings ->
 * Vault. A revealed value lives only in the state of the component
 * showing it: never cached (`no-store`), never stored, gone when the
 * 30-second timer runs out or the dialog closes.
 */

export type RevealAnswer =
  { ok: true; value: string } | { ok: false; status: number; code: unknown };

/** POST /api/vault/reveal; a network failure is a status-0 answer. */
export async function requestReveal(
  token: string,
  reason: string
): Promise<RevealAnswer> {
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
    if (res.ok && typeof json?.value === 'string')
      return { ok: true, value: json.value };
    return { ok: false, status: res.status, code: json?.code };
  } catch {
    return { ok: false, status: 0, code: undefined };
  }
}

/** Best-effort: overwrites a copied value; the browser may refuse without focus. */
function clearCopied(copied: { current: boolean }) {
  if (!copied.current) return;
  copied.current = false;
  try {
    void navigator.clipboard.writeText('').catch(() => {});
  } catch {
    // no clipboard access: nothing more to do
  }
}

/**
 * One revealed value with a copy button and the countdown; calls
 * `onExpire` (which must drop the value) after REVEAL_VISIBLE_MS. Mount
 * it once per reveal (a fresh key) so the timer starts over.
 */
export function RevealedValue({
  value,
  onExpire,
}: {
  value: string;
  onExpire: () => void;
}) {
  const t = useTranslations('Memory');
  const [left, setLeft] = useState(Math.ceil(REVEAL_VISIBLE_MS / 1000));
  const expire = useRef(onExpire);
  // Set once the value has been put on the OS clipboard, so expiry and
  // unmount can overwrite it.
  const copied = useRef(false);
  useEffect(() => {
    expire.current = onExpire;
  });

  useEffect(() => () => clearCopied(copied), []);

  useEffect(() => {
    const until = Date.now() + REVEAL_VISIBLE_MS;
    const timer = setInterval(() => {
      const ms = until - Date.now();
      if (ms <= 0) {
        clearInterval(timer);
        clearCopied(copied);
        expire.current();
      } else setLeft(Math.ceil(ms / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copied.current = true;
      toast.success(t('reveal.copied'));
    } catch {
      toast.error(t('reveal.copyFailed'));
    }
  };

  return (
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
      <p className="text-muted-foreground text-xs">
        {t('reveal.copyClearNote')}
      </p>
      <p className="text-muted-foreground text-xs" role="status">
        {t('reveal.hidesIn', { seconds: left })}
      </p>
    </div>
  );
}

/**
 * Asks for a reason, reveals one vaulted value and shows it for 30
 * seconds (Memory's token chips).
 */
export function RevealDialog({
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
  const [hidden, setHidden] = useState(false);

  const trimmed = reason.trim();
  const tooLong = [...reason].length > REVEAL_REASON_MAX;
  const identifier = reasonLooksLikeIdentifier(reason);

  const reveal = async () => {
    if (!trimmed || tooLong || identifier) return;
    setBusy(true);
    setError(null);
    const answer = await requestReveal(token, reason);
    setBusy(false);
    if (answer.ok) {
      setHidden(false);
      setValue(answer.value);
    } else
      setError(
        t(`reveal.errors.${revealErrorKey(answer.status, answer.code)}`)
      );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('reveal.title', { label })}</DialogTitle>
          <DialogDescription>{t('reveal.body')}</DialogDescription>
        </DialogHeader>

        {value !== null ? (
          <RevealedValue
            value={value}
            onExpire={() => {
              setValue(null);
              setHidden(true);
            }}
          />
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
              aria-invalid={tooLong || identifier || undefined}
            />
            {identifier && (
              <p className="text-destructive text-xs" role="alert">
                {t('reveal.reasonIdentifier')}
              </p>
            )}
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
              disabled={busy || !trimmed || tooLong || identifier}
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
