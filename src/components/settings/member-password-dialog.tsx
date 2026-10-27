'use client';

// ============================================================
// Set another member's password (Settings → Members, migration 140).
//
// Like Add person, the new password is shown in plain text and starts as
// a suggestion: the admin has to pass it on, and with no outbound mail
// there is no reset link to fall back on when a masked typo slips
// through. The database decides who may set whose password
// (`authorize_member_password_change`); the roster offers the button only
// where `canChangePasswordOf` says it can pass in this workspace.
// ============================================================

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { passwordProblem } from '@/lib/account/member-password';
import { MIN_PASSWORD_LENGTH, suggestPassword } from '@/lib/workspaces/form';

export interface PasswordDialogMember {
  user_id: string;
  /** As the roster shows them. */
  name: string;
}

export function MemberPasswordDialog({
  member,
  onClose,
}: {
  /** The person whose password is being set; null closes the dialog. */
  member: PasswordDialogMember | null;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.members.password');
  const [password, setPassword] = useState(suggestPassword);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The request in flight, so a reply can tell whether it still belongs
  // to what is on screen.
  const requestRef = useRef(0);

  const problem = passwordProblem(password);
  const canSubmit = !!member && !problem && !submitting;

  function reset() {
    setPassword(suggestPassword());
    setError(null);
    setSubmitting(false);
  }

  async function handleSave() {
    if (!member || !canSubmit) return;
    const request = ++requestRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/account/members/${encodeURIComponent(member.user_id)}/password`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (request !== requestRef.current) return;
      if (!res.ok) {
        setError(
          typeof payload?.error === 'string' ? payload.error : t('failed')
        );
        return;
      }
      // Not echoing the password: toasts linger.
      toast.success(t('done', { name: member.name }));
      reset();
      onClose();
    } catch {
      if (request === requestRef.current) setError(t('failed'));
    } finally {
      if (request === requestRef.current) setSubmitting(false);
    }
  }

  // While a change is in flight the dialog stays open: closing it would
  // throw away the password on screen while the change still lands, and
  // let its late reply speak for the next person opened.
  function close() {
    if (submitting) return;
    requestRef.current++;
    reset();
    onClose();
  }

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title', { name: member?.name ?? '' })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-2 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <Label
            htmlFor="member-new-password"
            className="text-muted-foreground"
          >
            {t('label')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="member-new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={password !== '' && problem !== null}
              className="border-border text-foreground font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                setPassword(suggestPassword());
                setError(null);
              }}
              title={t('regenerate')}
              aria-label={t('regenerate')}
              className="border-border shrink-0"
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          <p
            className={
              password !== '' && problem
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {password !== '' && problem
              ? t(`problem.${problem}`, { min: MIN_PASSWORD_LENGTH })
              : t('hint', { min: MIN_PASSWORD_LENGTH })}
          </p>
          {error ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive-soft text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {error}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!canSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
