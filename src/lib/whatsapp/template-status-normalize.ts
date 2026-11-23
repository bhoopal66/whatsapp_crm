import type { MessageTemplateStatus } from '@/types'

const ALLOWED: ReadonlyArray<MessageTemplateStatus> = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
]

/**
 * Meta's events that mean one of our statuses without sharing its name.
 * A FLAGGED template (low quality, may be paused later) still sends, and
 * a REINSTATED one sends again; a DELETED one never will.
 */
const ALIASES: Readonly<Record<string, MessageTemplateStatus>> = {
  PENDING_REVIEW: 'PENDING',
  REINSTATED: 'APPROVED',
  FLAGGED: 'APPROVED',
  DELETED: 'DISABLED',
}

/**
 * Normalize an upstream status string (the status webhook's event) into
 * our `MessageTemplateStatus` enum, or `null` when it is not a status we
 * know. A guess would do harm: `PENDING` is refused by every sender, so
 * an unknown event used to take a usable template out of service until
 * somebody pressed Sync.
 */
export function normalizeStatus(raw: string): MessageTemplateStatus | null {
  const upper = (raw ?? '').toUpperCase()
  if ((ALLOWED as readonly string[]).includes(upper)) {
    return upper as MessageTemplateStatus
  }
  return Object.hasOwn(ALIASES, upper) ? ALIASES[upper] : null
}
