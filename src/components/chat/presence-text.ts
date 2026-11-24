import { formatDistance } from 'date-fns';
import type { useTranslations } from 'next-intl';

import { dateFnsLocale } from '@/i18n/ui-locale';
import type { PresenceTooltip } from '@/lib/presence';

/** A presence dot's tooltip in the page's language. */
export function presenceText(
  t: ReturnType<typeof useTranslations<'Presence'>>,
  tooltip: PresenceTooltip,
  now: number
): string {
  if (tooltip.key !== 'offlineSince') return t(tooltip.key);
  return t('offlineSince', {
    when: formatDistance(tooltip.lastSeen, now, {
      addSuffix: true,
      locale: dateFnsLocale(),
    }),
  });
}
