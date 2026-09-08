'use client';

// ============================================================
// Create a teammate's login directly.
//
// Self-service signup no longer exists — /signup is gone — so this
// dialog is the only way a new person gets into the CRM. The admin
// sets the email, name, password and role; POST /api/account/members
// creates the login already confirmed and already in this account.
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
import type { AccountMember } from '@/types';

/** Mirrors ASSIGNABLE_ROLES in the members API. `owner` is absent by
 *  design — an account has exactly one, changed via ownership transfer. */
type AssignableRole = 'admin' | 'team_leader' | 'agent' | 'viewer';

/** Mirrors MIN_PASSWORD_LENGTH server-side, so an obviously-short
 *  password is caught before the round-trip. */
const MIN_PASSWORD_LENGTH = 8;

interface CreateMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (member: AccountMember) => void;
}

/** A readable, typo-resistant suggestion the admin can hand over as-is. */
function suggestPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
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
  const [role, setRole] = useState<AssignableRole>('agent');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setEmail('');
    setFullName('');
    setPassword(suggestPassword());
    setRole('agent');
    setSubmitting(false);
  }

  const emailLooksValid = /.+@.+\..+/.test(email.trim());
  const canSubmit =
    emailLooksValid && password.length >= MIN_PASSWORD_LENGTH && !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim(),
          password,
          role,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload?.error || t('failed'));
        return;
      }

      // The inbox's assignee picker caches the member list; a login
      // created here has to show up there without a reload.
      invalidateCached(MEMBERS_CACHE_KEY);
      onCreated(payload.member as AccountMember);
      // Deliberately not echoing the password into the toast — it is
      // still on screen behind the closing dialog, and toasts linger.
      toast.success(t('created', { email: email.trim() }));
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
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              autoFocus
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('nameLabel')}</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('passwordLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-muted border-border text-foreground font-mono"
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
            <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('roleLabel')}</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as AssignableRole)}
            >
              <SelectTrigger className="w-full bg-muted border-border text-foreground">
                <SelectValue>{tRoles(role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{tRoles('admin')}</SelectItem>
                <SelectItem value="team_leader">{tRoles('team_leader')}</SelectItem>
                <SelectItem value="agent">{tRoles('agent')}</SelectItem>
                <SelectItem value="viewer">{tRoles('viewer')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {tRoles(
                `${role}Hint` as
                  | 'adminHint'
                  | 'team_leaderHint'
                  | 'agentHint'
                  | 'viewerHint',
              )}
            </p>
          </div>
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
