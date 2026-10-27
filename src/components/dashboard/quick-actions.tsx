"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'
import { hasMinRole, type AccountRole } from '@/lib/auth/roles'
import { cn } from '@/lib/utils'
import { ICON_TONE_CLASSES, type IconTone } from './metric-card'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tone: IconTone
  /** Minimum role that may use this shortcut. Omitted = everyone.
   *  Broadcasts and automations are admin+ screens (agents may create
   *  their own deals), so a
   *  tile an agent cannot open would just bounce them back here. */
  minRole?: AccountRole
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tone: 'violet' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tone: 'emerald', minRole: 'agent' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tone: 'amber', minRole: 'admin' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tone: 'primary', minRole: 'admin' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  const { profileLoading, accountRole } = useAuth()

  // Fails closed while the role loads, same as the sidebar.
  const actions = ACTIONS.filter(
    (a) =>
      !a.minRole ||
      (!profileLoading && !!accountRole && hasMinRole(accountRole, a.minRole)),
  )

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs transition-colors hover:border-primary/30 hover:bg-card-2 dark:shadow-none dark:hover:border-border dark:hover:bg-muted/60"
          >
            <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', ICON_TONE_CLASSES[a.tone])}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
