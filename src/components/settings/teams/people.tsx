'use client';

// Small presentational pieces the Teams screen repeats: a member's
// avatar, a stacked avatar row, a role chip, and a number chip.

import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Phone } from 'lucide-react';

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { displayName, initialsOf } from '@/lib/teams/teams';
import { channelNameWithPhone } from '@/lib/whatsapp/channel-management';
import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import type { AccountMember } from '@/types';
import { SettingsChip } from '../settings-chip';
import { ROLE_META } from '../role-meta';

/** Extra props are forwarded, so it can be a Tooltip's `render` target. */
export function MemberAvatar({
  member,
  className,
  ...rest
}: ComponentProps<typeof Avatar> & {
  member: Pick<AccountMember, 'full_name' | 'email' | 'avatar_url'> & {
    deactivated_at?: string | null;
  };
}) {
  const name = displayName(member);
  return (
    <Avatar
      {...rest}
      // Opaque base under the tinted fallback: in an AvatarStack the
      // avatars overlap, and a see-through one shows its neighbour's
      // initials through it.
      className={cn(
        'bg-background',
        member.deactivated_at && 'opacity-50',
        className
      )}
    >
      {member.avatar_url ? (
        <AvatarImage src={member.avatar_url} alt={name} />
      ) : null}
      <AvatarFallback className="bg-primary/10 text-primary font-medium group-data-[size=sm]/avatar:text-[10px]">
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Overlapping avatars, at most `max`, with a "+N" for the rest. */
export function AvatarStack({
  members,
  max = 4,
}: {
  members: AccountMember[];
  max?: number;
}) {
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  return (
    // Overlap kept small enough that two-letter initials stay legible.
    <AvatarGroup className="-space-x-1">
      {shown.map((m) => (
        <Tooltip key={m.user_id}>
          <TooltipTrigger render={<MemberAvatar member={m} size="sm" />} />
          <TooltipContent>{displayName(m)}</TooltipContent>
        </Tooltip>
      ))}
      {rest > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <AvatarGroupCount className="text-[11px] font-medium">
                +{rest}
              </AvatarGroupCount>
            }
          />
          <TooltipContent>
            {members
              .slice(max)
              .map((m) => displayName(m))
              .join(', ')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </AvatarGroup>
  );
}

export function RoleChip({ role }: { role: AccountMember['role'] }) {
  const tRoles = useTranslations('Settings.roles');
  const meta = ROLE_META[role];
  const Icon = meta.icon;
  return (
    <SettingsChip
      variant={meta.variant}
      className="px-2 text-[11px] [&_svg]:size-3"
    >
      <Icon />
      {tRoles(role)}
    </SettingsChip>
  );
}

/** "Sales · +971…" for a Whapi number, the name alone for Meta. */
export function NumberChip({ number }: { number: AccountNumber }) {
  return (
    <span
      title={channelNameWithPhone(number)}
      className="border-border bg-muted/60 text-foreground inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"
    >
      <Phone className="text-muted-foreground size-3 shrink-0" />
      <span className="truncate">{channelNameWithPhone(number)}</span>
    </span>
  );
}
