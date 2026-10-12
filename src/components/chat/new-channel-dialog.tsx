'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Hash, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAuth } from '@/hooks/use-auth';
import { createChannel } from '@/lib/chat';
import {
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  normalizeChannelName,
} from '@/lib/chat/compose';
import {
  createChannelInput,
  nameTakenError,
  privateMemberCandidates,
  type NewChannelType,
} from '@/lib/chat/new-channel';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { GREEN_BUTTON, PeoplePicker } from './dm-picker';

const FIELD_LABEL = 'text-sm font-semibold';
const INPUT_BOX =
  'border-input bg-background focus-within:border-ring flex items-center gap-2 rounded-lg border px-2.5 py-2';

interface TypeCard {
  type: NewChannelType;
  title: string;
  body: string;
  disabled: boolean;
}

function NewChannelBody({
  onDone,
  onCreateDealRoom,
}: {
  onDone: () => void;
  onCreateDealRoom?: () => void;
}) {
  const t = useTranslations('Chat.newChannel');
  const router = useRouter();
  const { account, workspaces, activeWorkspaceId, accountRole } = useAuth();
  const ws = useChatWorkspaceContext();
  const [type, setType] = useState<NewChannelType>('team');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [takenByServer, setTakenByServer] = useState(false);
  const [busy, setBusy] = useState(false);

  const wsName =
    workspaces.find((w) => w.accountId === activeWorkspaceId)?.name ??
    account?.name ??
    '';
  const candidates = useMemo(
    () => privateMemberCandidates(ws.people, ws.userId, accountRole),
    [ws.people, ws.userId, accountRole]
  );
  const input = createChannelInput(
    { type, name, topic, memberIds },
    ws.accountId,
    ws.channels ?? []
  );
  const taken = input === 'taken' || takenByServer;

  const cards: TypeCard[] = [
    { type: 'team', title: t('team'), body: t('teamBody'), disabled: false },
    {
      type: 'private',
      title: t('private'),
      body: t('privateBody'),
      disabled: false,
    },
    {
      type: 'deal_room',
      title: t('dealRoom'),
      body: t('dealRoomBody'),
      disabled: !onCreateDealRoom,
    },
  ];

  const choose = (next: NewChannelType) => {
    setType(next);
    if (next === 'deal_room') onCreateDealRoom?.();
  };

  const create = async () => {
    if (typeof input === 'string' || takenByServer || busy) return;
    setBusy(true);
    try {
      const id = await createChannel(ws.sb, input);
      await ws.reloadChannels();
      onDone();
      router.push(`/chat/${id}`);
    } catch (err) {
      if (nameTakenError(err)) setTakenByServer(true);
      else ws.fail(err);
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-lg font-bold">{t('title')}</DialogTitle>
        {wsName && (
          <DialogDescription>
            {t('subtitle', { workspace: wsName })}
          </DialogDescription>
        )}
      </DialogHeader>

      <div className="space-y-2">
        <p className={FIELD_LABEL} id="new-channel-type">
          {t('type')}
        </p>
        <RadioGroup
          aria-labelledby="new-channel-type"
          value={type}
          onValueChange={(v) => choose(v as NewChannelType)}
          className="grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {cards.map((c) => {
            const on = c.type === type;
            const deal = c.type === 'deal_room';
            return (
              <label
                key={c.type}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 transition-colors',
                  !on && 'border-border hover:bg-muted/40',
                  on &&
                    !deal &&
                    'border-[#0E7C5A] bg-emerald-50/70 [[data-mode=dark]_&]:bg-emerald-500/10',
                  on &&
                    deal &&
                    'border-amber-500 bg-[#FFF8E6] text-[#7A4A12] [[data-mode=dark]_&]:bg-amber-500/10 [[data-mode=dark]_&]:text-amber-200',
                  c.disabled && 'cursor-not-allowed opacity-60'
                )}
              >
                <RadioGroupItem
                  value={c.type}
                  disabled={c.disabled}
                  className="mt-0.5"
                />
                <span className="min-w-0 space-y-1">
                  <span className="block text-sm font-semibold">{c.title}</span>
                  <span
                    className={cn(
                      'block text-xs leading-snug',
                      on && deal ? 'opacity-90' : 'text-muted-foreground'
                    )}
                  >
                    {c.body}
                  </span>
                  {deal && c.disabled && (
                    <span className="block text-xs font-semibold text-amber-700 [[data-mode=dark]_&]:text-amber-300">
                      {t('dealRoomSoon')}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </div>

      {type !== 'deal_room' && (
        <div
          className={cn('grid gap-6', type === 'private' && 'sm:grid-cols-2')}
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="new-channel-name" className={FIELD_LABEL}>
                {t('name')}
              </label>
              <div className={cn(INPUT_BOX, taken && 'border-destructive')}>
                {type === 'private' ? (
                  <Lock className="text-muted-foreground size-4" aria-hidden />
                ) : (
                  <Hash className="text-muted-foreground size-4" aria-hidden />
                )}
                <input
                  id="new-channel-name"
                  value={name}
                  onChange={(e) => {
                    setName(normalizeChannelName(e.target.value));
                    setTakenByServer(false);
                  }}
                  maxLength={CHANNEL_NAME_MAX}
                  placeholder={t('namePlaceholder')}
                  aria-invalid={taken || undefined}
                  aria-describedby={
                    taken ? 'new-channel-name-error' : undefined
                  }
                  autoComplete="off"
                  autoFocus
                  className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
              {taken && (
                <p
                  id="new-channel-name-error"
                  className="text-destructive text-xs"
                  role="alert"
                >
                  {t('nameTaken')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="new-channel-topic" className={FIELD_LABEL}>
                {t('topic')}{' '}
                <span className="text-muted-foreground font-normal">
                  {t('optional')}
                </span>
              </label>
              <div className={INPUT_BOX}>
                <input
                  id="new-channel-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  maxLength={CHANNEL_TOPIC_MAX}
                  placeholder={t('topicPlaceholder')}
                  autoComplete="off"
                  className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
            </div>
          </div>
          {type === 'private' && (
            <div className="min-w-0 space-y-1.5">
              <p className={FIELD_LABEL}>{t('members')}</p>
              <PeoplePicker
                candidates={candidates}
                picked={memberIds}
                onChange={setMemberIds}
              />
            </div>
          )}
        </div>
      )}

      <DialogFooter className="sm:-mx-6 sm:-mb-6 sm:px-6">
        <Button type="button" variant="outline" onClick={onDone}>
          {t('cancel')}
        </Button>
        {type !== 'deal_room' && (
          <Button
            type="submit"
            className={GREEN_BUTTON}
            disabled={typeof input === 'string' || taken || busy}
          >
            {busy ? t('creating') : t('create')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * "New channel or group", from the sidebar's pencil. Team and private
 * channels are made here; a deal room is handed to `onCreateDealRoom`
 * (its own form) and is shown as coming soon until that exists.
 */
export function NewChannelDialog({
  open,
  onOpenChange,
  onCreateDealRoom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateDealRoom?: () => void;
}) {
  const { isBankGuest } = useAuth();
  if (isBankGuest) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-auto bottom-0 left-0 max-h-[92dvh] w-full max-w-full translate-x-0 translate-y-0 overflow-y-auto rounded-b-none sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[90dvh] sm:max-w-[1000px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:gap-5 sm:rounded-xl sm:p-6">
        {open && (
          <NewChannelBody
            onDone={() => onOpenChange(false)}
            onCreateDealRoom={onCreateDealRoom}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
