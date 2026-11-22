import { hrGateOpen, type HrNavGate } from '@/components/layout/nav-items';
import type { HrRoles } from '@/lib/hr/types';

/**
 * The tabs of the HR area (/hr/*), in order. One sidebar row ("HR")
 * opens the area; these are its screens. Each tab is shown to exactly
 * the people its former sidebar row was: `gate` is the same
 * {@link HrNavGate} (`hrGateOpen`), and each route's HrAccessLayout
 * stays the server-side guard. Old /hr/* URLs keep working.
 */
export interface HrTab {
  href: string;
  /** Key in the `HrTabs` message namespace. */
  labelKey: string;
  gate: HrNavGate;
}

export const HR_TABS: readonly HrTab[] = [
  { href: '/hr/recruiter', labelKey: 'recruiter', gate: 'recruiter' },
  { href: '/hr/department', labelKey: 'department', gate: 'dept' },
  { href: '/hr/unsorted', labelKey: 'unsorted', gate: 'any' },
  { href: '/hr/tasks', labelKey: 'tasks', gate: 'any' },
  { href: '/hr/rules', labelKey: 'rules', gate: 'any' },
  { href: '/hr/hire-fast', labelKey: 'hireFast', gate: 'hireFast' },
  {
    href: '/hr/automated-messages',
    labelKey: 'automatedMessages',
    gate: 'automatedMessages',
  },
];

/** The tabs `roles` may open (none while the roles are unknown). */
export function visibleHrTabs(roles: HrRoles | null): HrTab[] {
  return HR_TABS.filter((tab) => hrGateOpen(tab.gate, roles));
}

/** Where /hr itself goes: the first tab this person may open, or null. */
export function hrLandingPath(roles: HrRoles | null): string | null {
  return visibleHrTabs(roles)[0]?.href ?? null;
}
