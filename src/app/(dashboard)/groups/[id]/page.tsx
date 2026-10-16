import { GroupPage } from '@/components/groups/group-page';

/** /groups/[id] — one WhatsApp group (chat, members, settings, invite…). */
export default async function GroupRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return (
    <GroupPage
      key={id}
      groupId={id}
      initialTab={Array.isArray(tab) ? tab[0] : tab}
    />
  );
}
