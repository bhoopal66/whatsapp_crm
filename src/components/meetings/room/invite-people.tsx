'use client';

import { Link2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { inviteCandidates } from '@/lib/meetings/room-ui/panels';

import { PersonAvatar } from '../person-avatars';
import { useWorkspaceMembers } from '../use-workspace-members';

/**
 * The organiser adds people from here. Everyone else gets the meeting's
 * link instead: the server lets only the organiser invite, even an admin
 * who isn't one.
 */
export function InvitePeople({
  call,
  taken,
  onInvited,
  requested,
  onRequestDone,
}: {
  call: MeetingCall;
  /** Who can't be picked: present, invited, removed or the organiser. */
  taken: readonly string[];
  onInvited: () => void;
  /** The empty room's own Invite button was pressed. */
  requested: boolean;
  onRequestDone: () => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const t = useTranslations('MeetingRoom.panels.invite');
  const hostId = call.meeting?.host_user_id;
  if (!hostId || hostId !== user?.id) return <CopyLinkButton call={call} />;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <UserPlus />
        {t('open')}
      </Button>
      {(open || requested) && (
        <InviteDialog
          call={call}
          taken={taken}
          onClose={() => {
            setOpen(false);
            onRequestDone();
          }}
          onInvited={onInvited}
        />
      )}
    </>
  );
}

function CopyLinkButton({ call }: { call: MeetingCall }) {
  const t = useTranslations('MeetingRoom.panels.invite');
  const meetingId = call.meeting?.id;
  if (!meetingId) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/meetings/${meetingId}`
      );
      toast.success(t('linkCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-full"
      onClick={() => void copy()}
    >
      <Link2 />
      {t('copyLink')}
    </Button>
  );
}

function InviteDialog({
  call,
  taken,
  onClose,
  onInvited,
}: {
  call: MeetingCall;
  taken: readonly string[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const t = useTranslations('MeetingRoom.panels.invite');
  const { members, avatarOf } = useWorkspaceMembers();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const candidates = useMemo(
    () => inviteCandidates(members, taken, query),
    [members, taken, query]
  );

  const toggle = (userId: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(userId);
    else next.delete(userId);
    setPicked(next);
  };

  const send = async () => {
    setSending(true);
    const invited = await call.invite([...picked]);
    setSending(false);
    if (!invited) {
      toast.error(t('failed'));
      return;
    }
    toast.success(t('sent', { count: invited.length }));
    onInvited();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-mode="dark" className="gap-3 rounded-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
        />
        <ul className="-mx-2 h-64 overflow-y-auto" aria-label={t('title')}>
          {candidates.map((m) => (
            <li key={m.user_id}>
              <label className="hover:bg-muted/60 flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none">
                <Checkbox
                  checked={picked.has(m.user_id)}
                  onCheckedChange={(on) => toggle(m.user_id, on)}
                />
                <PersonAvatar
                  size="sm"
                  person={{
                    userId: m.user_id,
                    name: m.full_name || m.email || '',
                    avatarUrl: avatarOf(m.user_id),
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {m.full_name || m.email}
                </span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="text-muted-foreground px-2 py-6 text-center text-sm">
              {t('nobody')}
            </li>
          )}
        </ul>
        <DialogFooter>
          <Button
            type="button"
            disabled={picked.size === 0 || sending}
            onClick={() => void send()}
          >
            {t('send', { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
