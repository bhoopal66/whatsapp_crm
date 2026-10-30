'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  BellOff,
  Hash,
  Lock,
  Megaphone,
  MessageCircle,
  Paperclip,
  ShieldCheck,
  User,
} from 'lucide-react';

import type { ChannelWithMembership } from '@/lib/chat';
import {
  audienceRoleOption,
  audienceSummary,
  isAnnouncementChannel,
  isRestrictedAudience,
} from '@/lib/chat/channel-rules';

import {
  audienceSummaryText,
  useChannelAudience,
} from './channel-rules-dialogs';

import { ChannelSettingsMenu } from './channel-settings';
import { DmCallButton } from './dm-call-button';

export interface ChannelHeaderProps {
  channel: ChannelWithMembership;
  name: string;
  memberCount: number | null;
  pinCount: number | null;
  /** Members panel (a later job). */
  onOpenMembers?: () => void;
  /** Pinned panel (a later job). */
  onOpenPins?: () => void;
  /** Files panel. */
  onOpenFiles?: () => void;
}

const BADGE =
  'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold';

const CHIP =
  'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50';

export function ChannelHeader({
  channel,
  name,
  memberCount,
  pinCount,
  onOpenMembers,
  onOpenPins,
  onOpenFiles,
}: ChannelHeaderProps) {
  const t = useTranslations('Chat.channel');
  const tSettings = useTranslations('Chat.settings');
  const tMute = useTranslations('Chat.mute');
  const tChat = useTranslations('Chat');
  const audience = useChannelAudience(channel);
  // A restricted audience shows once its teams are known (a role floor
  // alone already restricts, so it shows at once).
  const audienceForm = {
    role: audienceRoleOption(channel.audienceMinRole),
    teamIds: audience.teamIds ?? [],
    // "Its teams were deleted" only once the team list is known to be empty.
    teamRestricted: channel.audienceTeamRestricted && audience.teamIds !== null,
  };
  const restricted =
    channel.kind === 'team' && isRestrictedAudience(audienceForm);
  const audienceText = restricted
    ? audienceSummaryText(
        tChat,
        audienceSummary(audienceForm, audience.teams ?? [])
      )
    : null;
  const announcements =
    (channel.kind === 'team' || channel.kind === 'private') &&
    isAnnouncementChannel(channel);
  const kind = channel.kind;
  const Icon =
    kind === 'private'
      ? Lock
      : kind === 'dm'
        ? User
        : kind === 'deal_room'
          ? MessageCircle
          : Hash;
  const sub = [
    t(`kind.${kind}`),
    kind !== 'dm' && memberCount !== null
      ? t('members', { count: memberCount })
      : null,
    channel.topic,
  ].filter(Boolean);

  return (
    <header className="border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <Link
          href="/chat"
          className="hover:bg-muted -ml-1 rounded p-1 lg:hidden"
          aria-label={t('back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <h2 className="min-w-0 truncate text-base font-bold">{name}</h2>
        {channel.archivedAt && (
          <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            {tSettings('archivedBadge')}
          </span>
        )}
        {announcements && (
          <span
            className={`${BADGE} bg-warning-soft text-warning`}
            title={tChat('rules.announcementsHint')}
          >
            <Megaphone className="size-3" aria-hidden />
            {tChat('rules.announcements')}
          </span>
        )}
        {audienceText && (
          <span
            className={`${BADGE} bg-info-soft text-info`}
            title={audienceText}
          >
            <Lock className="size-3" aria-hidden />
            {tChat('rules.restricted')}
            <span className="sr-only">{audienceText}</span>
          </span>
        )}
        {channel.membership?.muted && (
          <span
            className="text-muted-foreground shrink-0"
            title={tMute('label')}
          >
            <BellOff className="size-3.5" aria-hidden />
            <span className="sr-only">{tMute('label')}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DmCallButton kind={kind} dmMemberIds={channel.dmMemberIds} />
          <ChannelSettingsMenu channel={channel} name={name} />
        </div>
      </div>
      <p className="text-muted-foreground mt-0.5 truncate text-xs">
        {sub.join(' · ')}
      </p>
      {kind !== 'deal_room' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <span className="bg-success-soft text-success flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium">
            <ShieldCheck className="size-3.5" aria-hidden />
            {t('internal')}
          </span>
          <button
            type="button"
            className={CHIP}
            onClick={onOpenMembers}
            disabled={!onOpenMembers}
          >
            {t('membersButton')}
          </button>
          <button
            type="button"
            className={CHIP}
            onClick={onOpenPins}
            disabled={!onOpenPins}
          >
            {t('pinned', { count: pinCount ?? 0 })}
          </button>
          <button
            type="button"
            className={CHIP}
            onClick={onOpenFiles}
            disabled={!onOpenFiles}
          >
            <Paperclip className="size-3.5" aria-hidden />
            {t('filesButton')}
          </button>
        </div>
      )}
    </header>
  );
}
