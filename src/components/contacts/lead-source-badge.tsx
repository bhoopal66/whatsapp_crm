'use client';

import {
  Compass,
  CircleHelp,
  FileUp,
  Globe,
  PencilLine,
  Send,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { LeadSource } from '@/lib/contacts/lead-source';

export const LEAD_SOURCE_ICONS: Record<LeadSource | 'unknown', LucideIcon> = {
  ad: Target,
  web_form: Globe,
  broadcast: Send,
  manual: PencilLine,
  import: FileUp,
  compass: Compass,
  other: CircleHelp,
  unknown: CircleHelp,
};

/** Icon and word, so the source never rests on colour. */
export function LeadSourceBadge({ source }: { source: LeadSource | null }) {
  const t = useTranslations('ContactsTable.source');
  const key = source ?? 'unknown';
  const Icon = LEAD_SOURCE_ICONS[key];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm whitespace-nowrap ${
        source ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {t(key)}
    </span>
  );
}
