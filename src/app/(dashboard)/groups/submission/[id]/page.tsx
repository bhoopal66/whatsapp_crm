import { SubmissionGroupPage } from '@/components/submission-groups/submission-group-page';

/**
 * /groups/submission/[id] — a submission group opened from the Groups
 * list, beside it in the same split view (`GroupsWorkspace` reads this
 * route's `id` too). The static `submission` segment wins over
 * /groups/[id].
 */
export default async function GroupsSubmissionRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SubmissionGroupPage key={id} groupId={id} backHref="/groups" />;
}
