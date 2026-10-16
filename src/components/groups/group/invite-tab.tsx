'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Loader2, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';

import { MemberPicker } from '@/components/groups/member-picker';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import {
  inviteMessagePreview,
  reasonKey,
  summarizeInviteSend,
  type InviteSendSummary,
} from '@/lib/groups/group-page';
import { INVITE_MESSAGE_MAX } from '@/lib/groups/member-requests';
import {
  GROUP_MEMBERS_PER_OPERATION,
  mergeMembers,
  parsePhoneList,
  type PickedContact,
} from '@/lib/groups/ui';

import type { GroupTabProps } from '../group-page';

interface Invite {
  code: string;
  link: string;
}

/** The Invite tab: the group link, resetting it, sending it to people. */
export function InviteTab({ groupId, detail }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const v = useTranslations('Groups.page.inviteTab');
  const url = `/api/whatsapp/groups/${groupId}/invite`;
  const blocked = detail.blocks.invite;

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(url);
      const json = (await res.json().catch(() => null)) as
        (Partial<Invite> & { code?: string }) | null;
      if (!res.ok || !json?.link) {
        setLoadError(
          t(`reasons.${reasonKey(res.ok ? undefined : json?.code)}`)
        );
        return;
      }
      setInvite({ code: json.code ?? '', link: json.link });
    } catch {
      setLoadError(t('reasons.unknown'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (blocked) {
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, blocked]);

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      toast.success(v('copied'));
    } catch {
      toast.error(v('copyFailed'));
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      });
      const json = (await res.json().catch(() => null)) as
        (Partial<Invite> & { code?: string }) | null;
      if (!res.ok || !json?.link) {
        toast.error(t(`reasons.${reasonKey(json?.code)}`));
        return;
      }
      setInvite({ code: json.code ?? '', link: json.link });
      toast.success(v('toastReset'));
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 overflow-y-auto pb-6">
      <p className="text-muted-foreground text-sm">{v('intro')}</p>
      {blocked && (
        <p className="text-muted-foreground text-xs">
          {v('blockedHint', { reason: t(`reasons.${reasonKey(blocked)}`) })}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="group-invite-link">{v('linkLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id="group-invite-link"
            readOnly
            dir="ltr"
            value={invite?.link ?? ''}
            placeholder={loading ? v('loading') : ''}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            disabled={!invite}
            onClick={() => void copy()}
          >
            <Copy className="size-4" />
            {v('copy')}
          </Button>
        </div>
        {loadError && (
          <p className="text-destructive text-xs">
            {loadError}{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void load()}
            >
              {t('retry')}
            </button>
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!!blocked || !invite}
          onClick={() => setSendOpen(true)}
        >
          <Send className="size-4" />
          {v('send')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!!blocked || resetting}
          onClick={() => setConfirmReset(true)}
        >
          {resetting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {v('reset')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={v('resetTitle')}
        description={v('resetBody')}
        cancelLabel={v('cancel')}
        confirmLabel={v('resetConfirm')}
        onConfirm={() => void reset()}
        destructive
      />

      {sendOpen && invite && (
        <SendDialog
          url={url}
          link={invite.link}
          onClose={() => setSendOpen(false)}
        />
      )}
    </div>
  );
}

const DEFAULT_KEYS = [
  'sent',
  'failed',
  'skipped',
  'notAttempted',
  'invalid',
] as const;

function SendDialog({
  url,
  link,
  onClose,
}: {
  url: string;
  link: string;
  onClose: () => void;
}) {
  const t = useTranslations('Groups.page');
  const v = useTranslations('Groups.page.inviteTab');
  const { accountId } = useAuth();
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [typedText, setTypedText] = useState('');
  const [message, setMessage] = useState(v('defaultMessage'));
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<InviteSendSummary | null>(null);

  const typed = useMemo(() => parsePhoneList(typedText), [typedText]);
  const merged = useMemo(
    () => mergeMembers(contacts, typed),
    [contacts, typed]
  );
  const count = merged.members.length;
  const canSubmit =
    count > 0 &&
    count <= GROUP_MEMBERS_PER_OPERATION &&
    message.length <= INVITE_MESSAGE_MAX &&
    !busy;

  const reasonText = (reason: string | null) => {
    if (!reason) return '';
    if (reason === 'opted_out') return v('reasonOptedOut');
    if (reason === 'do_not_contact') return v('reasonDoNotContact');
    if (reason === 'over_limit') return v('reasonOverLimit');
    if (reason === 'invalid' || reason === 'not_found') {
      return v('reasonInvalid');
    }
    return t(`reasons.${reasonKey(reason)}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          message,
          phones: merged.members.filter((x) => !x.contactId).map((x) => x.waId),
          contactIds: merged.members
            .map((x) => x.contactId)
            .filter((x): x is string => !!x),
        }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        toast.error(
          t(`reasons.${reasonKey((json as { code?: string } | null)?.code)}`)
        );
        return;
      }
      const s = summarizeInviteSend(json);
      setSummary(s);
      if (s.sent > 0) toast.success(v('toastSent', { count: s.sent }));
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (waId: string, contactId: string | null) =>
    merged.members.find(
      (m) => m.waId === waId || (contactId && m.contactId === contactId)
    )?.name ||
    waId ||
    contactId ||
    '';

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{v('sendTitle')}</DialogTitle>
          <DialogDescription>{v('sendDescription')}</DialogDescription>
        </DialogHeader>

        {summary ? (
          <div className="space-y-3">
            <p className="text-sm tabular-nums">
              {DEFAULT_KEYS.filter((k) => summary[k] > 0)
                .map((k) => v(`count.${k}`, { count: summary[k] }))
                .join(' · ') || v('nobody')}
            </p>
            <ul className="border-border divide-border max-h-60 divide-y overflow-y-auto rounded-lg border text-sm">
              {summary.rows.map((r, i) => (
                <li key={`${r.waId}-${i}`} className="flex gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(r.waId, r.contactId)}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {v(`status.${r.status}`)}
                    {r.reason ? ` · ${reasonText(r.reason)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {v('done')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <MemberPicker
              accountId={accountId}
              contacts={contacts}
              typedText={typedText}
              onContactsChange={setContacts}
              onTypedTextChange={setTypedText}
              merged={merged}
              typedInvalid={merged.invalidTyped}
            />
            <div className="space-y-1.5">
              <Label htmlFor="group-invite-message">{v('messageLabel')}</Label>
              <Textarea
                id="group-invite-message"
                rows={3}
                maxLength={INVITE_MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {v('messageHint')}
              </p>
              <div className="bg-muted rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap">
                <span className="text-muted-foreground block text-xs">
                  {v('preview')}
                </span>
                {inviteMessagePreview(message, link)}
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={onClose}
              >
                {v('cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? v('sending') : v('sendSubmit', { count })}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
