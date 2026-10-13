'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Pencil,
  Settings,
} from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import {
  setChannelArchived,
  setMuted,
  updateChannel,
  type ChannelWithMembership,
} from '@/lib/chat';
import {
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  normalizeChannelName,
} from '@/lib/chat/compose';
import {
  channelAdminErrorKey,
  channelEditInput,
  channelSettingsActions,
  chatErrorKey,
  muteAction,
} from '@/lib/chat/view';

import { useChatWorkspaceContext } from './chat-context';
import { GREEN_BUTTON } from './dm-picker';

/**
 * The channel header's settings (091): the viewer's own Mute / Unmute on
 * any channel or DM they belong to (muteAction), then rename and
 * re-topic, archive and unarchive, each offered only where
 * channelSettingsActions allows; the database decides. A write reloads
 * the channel list here, and realtime reloads everyone else's.
 */
export function ChannelSettingsMenu({
  channel,
  name,
}: {
  channel: ChannelWithMembership;
  name: string;
}) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const { accountRole } = useAuth();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'unarchive' | null>(null);
  const can = channelSettingsActions({
    kind: channel.kind,
    archived: !!channel.archivedAt,
    myRole: channel.membership?.role ?? null,
    accountRole,
  });
  const mute = muteAction(channel.membership);
  const manages = can.edit || can.archive || can.unarchive;
  if (!manages && !mute) return null;

  const toggleMute = async (muted: boolean) => {
    try {
      await setMuted(ws.sb, channel.id, muted);
      toast.success(t(muted ? 'mute.muted' : 'mute.unmuted'));
      // The row's switch and the counts; realtime catches up the rest.
      await Promise.all([ws.reloadChannels(), ws.refreshUnread()]);
    } catch (err) {
      toast.error(t(`errors.${chatErrorKey(err)}`));
    }
  };

  const setArchived = async (archived: boolean) => {
    setConfirm(null);
    try {
      await setChannelArchived(ws.sb, channel.id, archived);
      toast.success(t(archived ? 'settings.archived' : 'settings.unarchived'));
      await ws.reloadChannels();
    } catch (err) {
      toast.error(
        t(channelAdminErrorKey(archived ? 'archive' : 'unarchive', err))
      );
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('settings.menu')}
          title={t('settings.menu')}
          className="hover:bg-muted flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <Settings className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {mute && (
            <DropdownMenuItem onClick={() => void toggleMute(mute === 'mute')}>
              {mute === 'mute' ? <BellOff aria-hidden /> : <Bell aria-hidden />}
              {t(`mute.${mute}`, { kind: channel.kind })}
            </DropdownMenuItem>
          )}
          {mute && manages && <DropdownMenuSeparator />}
          {can.edit && (
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {t('settings.edit')}
            </DropdownMenuItem>
          )}
          {can.archive && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirm('archive')}
            >
              <Archive aria-hidden />
              {t('settings.archive')}
            </DropdownMenuItem>
          )}
          {can.unarchive && (
            <DropdownMenuItem onClick={() => setConfirm('unarchive')}>
              <ArchiveRestore aria-hidden />
              {t('settings.unarchive')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-md">
          {editing && (
            <EditChannelForm
              channel={channel}
              onDone={() => setEditing(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(
          confirm === 'unarchive'
            ? 'settings.unarchiveTitle'
            : 'settings.archiveTitle',
          { name }
        )}
        description={t(
          confirm === 'unarchive'
            ? 'settings.unarchiveBody'
            : 'settings.archiveBody'
        )}
        cancelLabel={t('settings.cancel')}
        confirmLabel={t(
          confirm === 'unarchive'
            ? 'settings.unarchiveConfirm'
            : 'settings.archiveConfirm'
        )}
        onConfirm={() => void setArchived(confirm !== 'unarchive')}
        destructive={confirm !== 'unarchive'}
      />
    </>
  );
}

/** Rename and re-topic. A kept field is sent as null, a cleared topic as ''. */
function EditChannelForm({
  channel,
  onDone,
}: {
  channel: ChannelWithMembership;
  onDone: () => void;
}) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [busy, setBusy] = useState(false);
  const [takenByServer, setTakenByServer] = useState(false);
  const input = channelEditInput({ name, topic }, channel, ws.channels ?? []);
  const taken = input === 'taken' || takenByServer;
  const nameError = taken
    ? t('errors.duplicateName')
    : input === 'empty'
      ? t('settings.nameEmpty')
      : null;

  const save = async () => {
    if (typeof input === 'string' || takenByServer || busy) return;
    setBusy(true);
    try {
      await updateChannel(ws.sb, { channelId: channel.id, ...input });
      toast.success(t('settings.saved'));
      await ws.reloadChannels();
      onDone();
    } catch (err) {
      const key = channelAdminErrorKey('edit', err);
      if (key === 'errors.duplicateName') setTakenByServer(true);
      else toast.error(t(key));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('settings.editTitle')}</DialogTitle>
        <DialogDescription>{t('settings.editBody')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="channel-settings-name">{t('settings.name')}</Label>
          <Input
            id="channel-settings-name"
            value={name}
            onChange={(e) => {
              setName(normalizeChannelName(e.target.value));
              setTakenByServer(false);
            }}
            maxLength={CHANNEL_NAME_MAX}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={
              nameError ? 'channel-settings-name-error' : undefined
            }
            autoComplete="off"
            autoFocus
          />
          {nameError && (
            <p
              id="channel-settings-name-error"
              className="text-destructive text-xs"
              role="alert"
            >
              {nameError}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="channel-settings-topic">
            {t('settings.topic')}{' '}
            <span className="text-muted-foreground font-normal">
              {t('settings.optional')}
            </span>
          </Label>
          <Input
            id="channel-settings-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={CHANNEL_TOPIC_MAX}
            placeholder={t('settings.topicPlaceholder')}
            aria-describedby="channel-settings-topic-hint"
            autoComplete="off"
          />
          <p
            id="channel-settings-topic-hint"
            className="text-muted-foreground text-xs"
          >
            {t('settings.topicHint')}
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('settings.cancel')}
        </Button>
        <Button
          type="submit"
          className={GREEN_BUTTON}
          disabled={typeof input === 'string' || takenByServer || busy}
        >
          {busy ? t('settings.saving') : t('settings.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
