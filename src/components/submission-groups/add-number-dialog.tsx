'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Add another phone number to a submission group's WhatsApp group
 * (migration 211). When WhatsApp declines (the person's privacy
 * settings), the dialog shows the group's invite link for the staff
 * member to share: nothing is sent to the number from here.
 */
export function AddNumberDialog({
  groupId,
  onClose,
  onAdded,
}: {
  groupId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useTranslations('SubmissionGroups.addNumber');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState<{ link: string | null } | null>(
    null
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/submission-groups/${groupId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        }
      );
      const json = (await res.json().catch(() => null)) as {
        added?: unknown;
        inviteLink?: unknown;
        error?: unknown;
      } | null;
      if (!res.ok) {
        setError(typeof json?.error === 'string' ? json.error : t('failed'));
        return;
      }
      onAdded();
      if (json?.added === true) {
        toast.success(t('added', { phone }));
        onClose();
      } else {
        setDeclined({
          link: typeof json?.inviteLink === 'string' ? json.inviteLink : null,
        });
      }
    } catch {
      setError(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {declined ? (
          <>
            <p className="text-sm">{t('declined', { phone })}</p>
            {declined.link ? (
              <div className="flex items-center gap-2">
                <code className="bg-card-2 min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">
                  {declined.link}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(declined.link!)}
                >
                  <Copy className="size-3.5" />
                  {t('copyLink')}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t('noLink')}</p>
            )}
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (phone.trim() && !busy) void submit();
            }}
          >
            <Input
              autoFocus
              inputMode="tel"
              aria-label={t('label')}
              placeholder={t('placeholder')}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={!phone.trim() || busy}>
                {busy ? t('adding') : t('submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
