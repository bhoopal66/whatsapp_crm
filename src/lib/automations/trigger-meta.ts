import type { LucideIcon } from 'lucide-react'
import { Sparkles } from 'lucide-react'

import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
  /** One line on what fires it, for triggers whose label alone is not
   *  self-explanatory. */
  description?: string
  /** Shown in the list pill when set. */
  icon?: LucideIcon
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  },
  chat_tag_set: {
    label: 'Chat Tag Set',
    pillClass: 'border-warning/30 bg-warning-soft text-warning',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-border bg-muted text-muted-foreground',
  },
  interactive_reply: {
    label: 'Button / List Reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300',
  },
  intent_match: {
    label: 'Customer means',
    description:
      "Jev judges the customer's message means what you described, in any wording or language",
    icon: Sparkles,
    pillClass: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  },
}

/** Triggers nothing dispatches: an automation with one never runs. Take
 *  one out when something calls `runAutomationsForTrigger` with it. */
const NOT_RUNNING_TRIGGERS: ReadonlySet<string> = new Set<AutomationTriggerType>([
  'time_based',
  'conversation_assigned',
])

export function triggerRuns(t: AutomationTriggerType | string): boolean {
  return !NOT_RUNNING_TRIGGERS.has(t)
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-border bg-muted text-muted-foreground',
    }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
