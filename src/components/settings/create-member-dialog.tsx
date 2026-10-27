'use client';

// ============================================================
// Add a person to this workspace by email (migration 083).
//
// Self-service signup no longer exists — /signup is gone — so this
// dialog is how a person gets into the CRM. One login can belong to
// several workspaces, so POST /api/account/members first tries the
// email as an existing login: that person is added with the password
// they already have, and nothing else is asked. Only when the API
// answers that no login uses the email does the dialog reveal the name
// and password fields and create one on the second submit.
//
// The password is shown in plain text rather than masked: the admin
// is typing a credential they then have to relay to the person it
// belongs to, and a masked field they cannot read back invites typos
// that only surface as a failed login later. There is no password
// reset on this deployment (no outbound mail), which makes an
// unreadable typo expensive.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { MEMBERS_CACHE_KEY, invalidateCached } from '@/lib/client-cache';
import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw, UserPlus } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ADDABLE_ROLES, type AddableRole } from '@/lib/account/add-member';
import {
  MIN_PASSWORD_LENGTH,
  isNoLoginError,
  suggestPassword,
} from '@/lib/workspaces/form';
import type { AccountMember } from '@/types';

interface CreateMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (member: AccountMember) => void;
}

export function CreateMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateMemberDialogProps) {
  const t = useTranslations('Settings.createMember');
  const tRoles = useTranslations('Settings.roles');

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState(suggestPassword);
  const [role, setRole] = useState<AddableRole>('agent');
  const [bankCode, setBankCode] = useState('');
  // Set once the API answers that no login uses this email.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setEmail('');
    setFullName('');
    setPassword(suggestPassword());
    setRole('agent');
    setBankCode('');
    setNeedsPassword(false);
    setSubmitting(false);
  }

  const emailLooksValid = /.+@.+\..+/.test(email.trim());
  const isGuest = role === 'bank_guest';
  const canSubmit =
    emailLooksValid &&
    (!isGuest || !!bankCode.trim()) &&
    (!needsPassword || password.length >= MIN_PASSWORD_LENGTH) &&
    !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          role,
          ...(isGuest ? { bankCode: bankCode.trim() } : {}),
          // Only a new login uses these; an existing one keeps its own.
          ...(needsPassword ? { full_name: fullName.trim(), password } : {}),
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!needsPassword && isNoLoginError(payload?.error)) {
          setNeedsPassword(true);
          return;
        }
        toast.error(payload?.error || t('failed'));
        return;
      }

      // The inbox's assignee picker caches the member list; a person
      // added here has to show up there without a reload.
      invalidateCached(MEMBERS_CACHE_KEY);
      onCreated(payload.member as AccountMember);
      // Deliberately not echoing the password into the toast — it is
      // still on screen behind the closing dialog, and toasts linger.
      toast.success(
        payload.created === false
          ? t('added', { email: email.trim() })
          : t('created', { email: email.trim() })
      );
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('emailLabel')}</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                // A different email may well have a login.
                setNeedsPassword(false);
              }}
              placeholder={t('emailPlaceholder')}
              autoFocus
              className="border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('roleLabel')}</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as AddableRole)}
            >
              <SelectTrigger className="border-border text-foreground w-full">
                <SelectValue>{tRoles(role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ADDABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tRoles(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {tRoles(`${role}Hint`)}
            </p>
          </div>

          {isGuest ? (
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('bankCodeLabel')}
              </Label>
              <Input
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
                placeholder={t('bankCodePlaceholder')}
                className="border-border text-foreground"
              />
              {!bankCode.trim() ? (
                <p className="text-muted-foreground text-xs">
                  {t('bankCodeRequired')}
                </p>
              ) : null}
            </div>
          ) : null}

          {needsPassword ? (
            <>
              <p
                role="status"
                className="border-warning/30 bg-warning-soft text-warning rounded-lg border px-3 py-2 text-xs"
              >
                {t('noLoginHint')}
              </p>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('nameLabel')}
                </Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                  className="border-border text-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="border-border text-foreground font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setPassword(suggestPassword())}
                    title={t('regenerate')}
                    className="border-border shrink-0"
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t('passwordHint')}
                </p>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPlus className="size-4" />
            )}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
