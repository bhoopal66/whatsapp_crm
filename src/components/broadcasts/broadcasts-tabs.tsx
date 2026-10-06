'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Radio, MessagesSquare } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Section switcher for Broadcasts: the campaign list, and the Campaign
 * inbox — the conversations that started as a reply to one of them
 * (migration 048) while the bot is answering them (067).
 * Rendered by both pages rather than the layout so the create/detail
 * screens stay uncluttered.
 */
export function BroadcastsTabs() {
  const t = useTranslations('Broadcasts.tabs');
  const pathname = usePathname();
  const tabs = [
    { href: '/broadcasts', label: t('campaigns'), icon: Radio },
    { href: '/broadcasts/inbox', label: t('inbox'), icon: MessagesSquare },
  ];

  return (
    <nav className="border-border flex gap-1 border-b" aria-label={t('label')}>
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
