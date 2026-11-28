/**
 * Pure pieces of the HR inbox's topic UI: the department filter's chip
 * row, the select's groups, and which setup links a role is offered.
 */
import {
  HR_TOPIC_FILTERS,
  HR_TOPIC_GROUPS,
  type HrRoles,
  type HrTopic,
  type HrTopicFilter,
  type HrTopicGroup,
} from './types';
import type { HrTab } from './list-filters';

export interface HrTopicChip {
  /** null is "All" (no filter). */
  value: HrTopicFilter | null;
  /** Key under the HR namespace's `topicFilter`. */
  labelKey: string;
}

/** All, then the filters in the order `HR_TOPIC_FILTERS` lists them. */
export function hrTopicChips(): HrTopicChip[] {
  return [
    { value: null, labelKey: 'topicFilter.all' },
    ...(Object.keys(HR_TOPIC_FILTERS) as HrTopicFilter[]).map((value) => ({
      value,
      labelKey: `topicFilter.${value}`,
    })),
  ];
}

export interface HrTopicOptGroup {
  group: HrTopicGroup;
  /** Key under the HR namespace's `topicGroup`. */
  labelKey: string;
  topics: readonly HrTopic[];
}

/** The topic select's `<optgroup>`s, in `HR_TOPIC_GROUPS` order. */
export function hrTopicOptGroups(): HrTopicOptGroup[] {
  return (Object.keys(HR_TOPIC_GROUPS) as HrTopicGroup[]).map((group) => ({
    group,
    labelKey: `topicGroup.${group}`,
    topics: HR_TOPIC_GROUPS[group],
  }));
}

export interface HrInboxLinks {
  hireFast: boolean;
  automatedMessages: boolean;
}

/** Hire fast: admins and any recruiter; Automated messages: admins and leads. */
export function hrInboxLinks(roles: HrRoles | null): HrInboxLinks {
  if (!roles) return { hireFast: false, automatedMessages: false };
  return {
    hireFast: roles.admin || roles.recruiter !== null,
    automatedMessages: roles.admin || roles.recruiter === 'lead',
  };
}

/**
 * One dot colour per topic, after the module package's palette (023e,
 * 023g). Complete literal class strings (Tailwind cannot see composed
 * names), each hue with a dark: pair. Red (and rose) stays reserved for
 * Urgent, so Complaint is pink, Warning letter fuchsia and Termination
 * the package's brown-tan; `topic-ui.test.ts` pins every topic mapped,
 * no two alike and no red.
 */
export const HR_TOPIC_DOT: Record<HrTopic, string> = {
  onboarding: 'bg-teal-600 dark:bg-teal-400',
  visa_documents: 'bg-amber-600 dark:bg-amber-400',
  leave_attendance: 'bg-orange-600 dark:bg-orange-400',
  payroll: 'bg-green-600 dark:bg-green-400',
  complaint: 'bg-pink-600 dark:bg-pink-400',
  other: 'bg-slate-500 dark:bg-slate-400',
  offer_letter: 'bg-blue-600 dark:bg-blue-400',
  training: 'bg-violet-600 dark:bg-violet-400',
  warning_letter: 'bg-fuchsia-600 dark:bg-fuchsia-400',
  message: 'bg-cyan-600 dark:bg-cyan-400',
  termination: 'bg-[#9a6444] dark:bg-[#c9946f]',
};

/**
 * The empty list's message key under the HR namespace: the department
 * inbox says "No staff conversations", every other tab keeps the inbox's
 * own empty text (null).
 */
export function hrEmptyKey(tab: HrTab): string | null {
  return tab === 'dept' ? 'list.deptEmpty' : null;
}
