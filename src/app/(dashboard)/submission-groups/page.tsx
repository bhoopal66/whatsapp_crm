import { SubmissionGroupsPlaceholder } from '@/components/submission-groups/submission-groups-workspace';

/**
 * /submission-groups — the list is the layout's (it stays mounted while
 * a submission is opened); this is the empty right pane.
 */
export default function SubmissionGroupsPage() {
  return <SubmissionGroupsPlaceholder />;
}
