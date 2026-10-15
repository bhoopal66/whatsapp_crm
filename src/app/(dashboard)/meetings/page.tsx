import { MeetingsView } from '@/components/meetings/meetings-view';
import { meetingScopeParam } from '@/lib/meetings/schedule';

/**
 * /meetings — Live now (default), Upcoming (?scope=upcoming) and Past
 * (?scope=past), migration 106.
 */
export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  return <MeetingsView scope={meetingScopeParam(scope)} />;
}
