import { SubmissionGroupPage } from '@/components/submission-groups/submission-group-page';

/** /submission-groups/[id] — one submission's group: chat, people, archive. */
export default async function SubmissionGroupRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SubmissionGroupPage key={id} groupId={id} />;
}
