import { GroupWall } from '@/components/groups/group-wall';

/** /group-wall: several groups side by side, live, read-only. */
export default async function GroupWallPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ids } = await searchParams;
  return <GroupWall idsParam={typeof ids === 'string' ? ids : null} />;
}
