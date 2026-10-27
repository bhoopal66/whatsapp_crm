'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { LogOut, Trash2, X } from 'lucide-react';

import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { InfoSection } from '@/lib/groups/group-page';
import { avatarToneIndex, groupInitials } from '@/lib/groups/ui';
import { cn } from '@/lib/utils';

import type { GroupTabProps } from './group-page';
import { AVATAR_TONES } from './groups-list';
import { InviteTab } from './group/invite-tab';
import { ManagersTab } from './group/managers-tab';
import { MembersTab } from './group/members-tab';
import { RequestsTab } from './group/requests-tab';
import { SettingsTab } from './group/settings-tab';

/**
 * The group's picture, or its initials when it has none (the icon route
 * answers 404). Re-key it on a picture change to try the image again.
 */
export function GroupAvatar({
  groupId,
  name,
  version,
  className,
}: {
  groupId: string;
  name: string;
  version: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium',
        // The list's colour for this group, so the initials match it.
        AVATAR_TONES[avatarToneIndex(groupId, AVATAR_TONES.length)],
        className
      )}
    >
      {failed ? (
        groupInitials(name)
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/whatsapp/groups/${groupId}/icon?v=${version}`}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** A section to expand and scroll to; `n` changes on every request. */
export interface InfoFocus {
  section: InfoSection;
  n: number;
}

/**
 * The "Group info" panel: the group's details, its sections (Members,
 * Invite link, Join requests, Settings, Managers — only those
 * `infoSections` allows) and Leave — or, for a group our number has
 * left, Delete from CRM (owner/admin). Docked beside the chat or inside a
 * sheet; the parent decides, the panel only fills its box.
 */
export function GroupInfoPanel({
  heading,
  onClose,
  tabProps,
  sections,
  open,
  onOpenChange,
  focus,
  pendingRequests,
  onRequestsCount,
  numberLabel,
  iconVersion,
  canLeave,
  onLeave,
  canDelete,
  onDelete,
}: {
  heading: ReactNode;
  onClose: () => void;
  tabProps: GroupTabProps;
  sections: InfoSection[];
  open: InfoSection[];
  onOpenChange: (open: InfoSection[]) => void;
  focus: InfoFocus | null;
  pendingRequests: number;
  onRequestsCount: (n: number) => void;
  /** "Sales · +971…", or null when the number is unknown. */
  numberLabel: string | null;
  iconVersion: number;
  canLeave: boolean;
  onLeave: () => void;
  /** The group is `left` and the caller may delete it from the CRM. */
  canDelete: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations('Groups.page');
  const locale = useLocale();
  const items = useRef(new Map<InfoSection, HTMLDivElement>());
  const { group } = tabProps.detail;

  // Bring a requested section into view once it is expanded and laid out.
  useEffect(() => {
    if (!focus) return;
    const id = requestAnimationFrame(() =>
      items.current
        .get(focus.section)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    );
    return () => cancelAnimationFrame(id);
  }, [focus]);

  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : t('never');

  const facts: Array<[string, string]> = [
    ...(numberLabel ? [[t('number'), numberLabel] as [string, string]] : []),
    [t('createdAt'), when(group.created_at)],
    [t('syncedAt'), when(group.synced_at)],
    [t('lastMessageAt'), when(group.last_message_at)],
    ...(group.left_at
      ? [[t('leftAt'), when(group.left_at)] as [string, string]]
      : []),
  ];

  const body = (s: InfoSection) => {
    switch (s) {
      case 'members':
        return <MembersTab {...tabProps} />;
      case 'invite':
        return <InviteTab {...tabProps} />;
      case 'requests':
        return <RequestsTab {...tabProps} onCount={onRequestsCount} />;
      case 'settings':
        return <SettingsTab {...tabProps} />;
      case 'managers':
        return <ManagersTab {...tabProps} />;
    }
  };

  return (
    <div className="bg-wa-panel text-wa-text flex h-full min-h-0 flex-col">
      <div className="bg-wa-panel-header border-wa-divider flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('closeInfo')}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
        {heading}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-wa-divider flex flex-col items-center gap-1 border-b px-4 py-5 text-center">
          <GroupAvatar
            key={iconVersion}
            groupId={tabProps.groupId}
            name={group.name}
            version={iconVersion}
            className="mb-2 size-20 text-xl"
          />
          <p className="text-wa-text max-w-full text-lg font-semibold break-words">
            {group.name}
          </p>
          <p className="text-wa-text-secondary text-sm">
            {t('members', { count: group.participants_count })}
          </p>
          {group.description && (
            <p className="text-wa-text-secondary mt-1 text-sm break-words whitespace-pre-wrap">
              {group.description}
            </p>
          )}
          <dl className="mt-3 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-xs">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-wa-meta">{label}</dt>
                <dd className="text-wa-text min-w-0 truncate" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <Accordion
          multiple
          value={open}
          onValueChange={(v) => onOpenChange(v as InfoSection[])}
          className="px-4"
        >
          {sections.map((s) => (
            <AccordionItem
              key={s}
              value={s}
              className="border-wa-divider scroll-mt-2"
              ref={(el: HTMLDivElement | null) => {
                if (el) items.current.set(s, el);
                else items.current.delete(s);
              }}
            >
              <AccordionTrigger className="py-3">
                <span className="flex items-center gap-2">
                  {t(`sections.${s}`)}
                  {s === 'requests' && pendingRequests > 0 && (
                    <Badge className="bg-info-soft text-info">
                      {pendingRequests}
                    </Badge>
                  )}
                </span>
              </AccordionTrigger>
              {/* The bare panel: the kit's content wrapper restyles every
                  link and paragraph inside, which the tabs don't expect. */}
              <AccordionPrimitive.Panel className="pb-4 text-sm">
                {body(s)}
              </AccordionPrimitive.Panel>
            </AccordionItem>
          ))}
        </Accordion>

        {canLeave && (
          <div className="border-wa-divider space-y-2 border-t px-4 py-4">
            <Button
              variant="destructive"
              className="w-full justify-start"
              onClick={onLeave}
            >
              <LogOut className="size-4" />
              {t('leave')}
            </Button>
            <p className="text-wa-text-secondary text-xs">{t('leaveHint')}</p>
          </div>
        )}
        {canDelete && (
          <div className="border-wa-divider space-y-2 border-t px-4 py-4">
            <Button
              variant="destructive"
              className="w-full justify-start"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              {t('deleteFromCrm')}
            </Button>
            <p className="text-wa-text-secondary text-xs">{t('deleteHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
