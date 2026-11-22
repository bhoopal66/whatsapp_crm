'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';

import { backPlan } from '@/lib/navigation/back-target';
import { cn } from '@/lib/utils';

const DEFAULT_CLASS =
  'text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline';

/**
 * An in-page "Back" that returns to wherever this tab came from
 * (`router.back()`), and only when nothing in-app came before (a fresh
 * tab, a reload, a link from outside) links to the page's own
 * `fallbackHref`. A detail page reached from Calls used to send people
 * to its list instead; see lib/navigation/back-target.ts.
 *
 * `fallbackLabel` replaces the derived label in link mode only, for a
 * page whose fallback has a name of its own (a flow's name). `iconOnly`
 * keeps the label as the accessible name and tooltip.
 */
export function BackLink({
  fallbackHref,
  fallbackLabel,
  className,
  iconOnly = false,
  iconClassName = 'size-4',
}: {
  fallbackHref: string;
  fallbackLabel?: string;
  className?: string;
  iconOnly?: boolean;
  iconClassName?: string;
}) {
  const t = useTranslations('BackNav');
  const router = useRouter();
  const pathname = usePathname();
  const plan = backPlan(fallbackHref, pathname ?? undefined);
  const label =
    plan.mode === 'link' && fallbackLabel ? fallbackLabel : t(plan.label);
  const cls = className ?? DEFAULT_CLASS;
  const content = (
    <>
      <ArrowLeft className={cn(iconClassName, 'rtl:rotate-180')} aria-hidden />
      {!iconOnly && label}
    </>
  );
  const a11y = iconOnly ? { 'aria-label': label, title: label } : {};

  if (plan.mode === 'history')
    return (
      <button
        type="button"
        onClick={() => router.back()}
        className={cn(cls, 'cursor-pointer')}
        {...a11y}
      >
        {content}
      </button>
    );
  return (
    <Link href={plan.href} className={cls} {...a11y}>
      {content}
    </Link>
  );
}
