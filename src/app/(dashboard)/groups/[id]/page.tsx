import { GroupPage } from '@/components/groups/group-page';

/** /groups/[id] — one WhatsApp group (chat, members, settings, invite…). */
export default async function GroupRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GroupPage key={id} groupId={id} />;
}
