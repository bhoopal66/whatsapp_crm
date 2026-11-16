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
