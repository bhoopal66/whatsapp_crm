'use client';

import { useId, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  coordinatorPhonesOf,
  endReasonView,
  inviteNotice,
  trackerStatusChip,
  type SgGroup,
  waModeOf,
} from '@/lib/submission-groups/ui';
import { cn } from '@/lib/utils';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Everything known about one submission group, as a definition list. */
export function GroupDetailsCard({
  group,
  onCopyRef,
}: {
  group: SgGroup;
  onCopyRef: () => void;
}) {
  const t = useTranslations('SubmissionGroups.details');
  const tp = useTranslations('SubmissionGroups.page');
  const locale = useLocale();
  const titleId = useId();
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : t('notSet');

  const ended = group.status === 'ENDED';
  const noGroup = waModeOf(group) === 'none';
  const chip = trackerStatusChip(group.submission_status);
  const invite = inviteNotice(group);
  const coordinatorPhones = coordinatorPhonesOf(group);
  const reason = endReasonView(group.end_reason);
  const reasonText =
    reason.key === 'none'
      ? null
      : reason.key === 'finalStatus'
        ? tp('endReason.finalStatus', { status: reason.status })
        : reason.key === 'other'
          ? tp('endReason.other', { reason: reason.raw })
          : tp(`endReason.${reason.key}`);
  const whatsapp = noGroup
    ? t('whatsappNone')
    : group.wa_group_id
      ? t('whatsappReady')
      : group.wa_create_error
        ? t('whatsappFailed')
        : t('whatsappPending');

  return (
    <section
      aria-labelledby={titleId}
      className="bg-card rounded-xl border p-4"
    >
      <h2 id={titleId} className="text-sm font-semibold">
        {t('title')}
      </h2>
      <dl className="divide-border mt-1 divide-y">
        <Row label={t('reference')}>
          <span className="flex items-start gap-1">
            <code className="min-w-0 font-mono text-xs break-all">
              {group.submission_ref}
            </code>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={tp('copyRef')}
              title={tp('copyRef')}
              onClick={onCopyRef}
            >
              <Copy aria-hidden />
            </Button>
          </span>
        </Row>
        {group.subject && <Row label={t('subject')}>{group.subject}</Row>}
        <Row label={t('trackerStatus')}>
          {chip ? (
            <span
              className={cn(
                'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                chip.chipClass
              )}
            >
              {chip.text}
            </span>
          ) : (
            t('notSet')
          )}
        </Row>
        <Row label={t('groupStatus')}>
          {ended ? tp('statusEnded') : tp('statusActive')}
        </Row>
        <Row label={t('whatsapp')}>{whatsapp}</Row>
        <Row label={t('opened')}>{date(group.created_at)}</Row>
        <Row label={t('lastActivity')}>
          {date(group.last_activity_at ?? group.created_at)}
        </Row>
        {ended && (
          <Row label={t('ended')}>
            {date(group.ended_at)}
            {reasonText && (
              <span className="text-muted-foreground block text-xs">
                {t('endReason')}: {reasonText}
              </span>
            )}
          </Row>
        )}
        {coordinatorPhones.length > 0 && (
          <Row label={t('coordinatorPhone')}>
            {coordinatorPhones.map((p) => (
              <span key={p} dir="ltr" className="block">
                {p}
              </span>
            ))}
          </Row>
        )}
        {!noGroup && (
          <Row label={t('number')}>
            {group.channel ? (
              group.channel.label || t('notSet')
            ) : (
              <span className="text-destructive">{tp('numberRemoved')}</span>
            )}
          </Row>
        )}
        {invite && (
          <Row label={t('invite')}>
            {invite.key === 'sent' ? (
              tp('inviteSent', { when: date(invite.at) })
            ) : (
              <span className="text-destructive">{tp('inviteFailed')}</span>
            )}
          </Row>
        )}
      </dl>
    </section>
  );
}
