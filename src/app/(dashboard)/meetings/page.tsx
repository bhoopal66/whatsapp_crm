import { MeetingsView } from '@/components/meetings/meetings-view';
import { meetingHubTab } from '@/lib/meetings/hub';
import { meetingScopeParam } from '@/lib/meetings/schedule';

/**
 * /meetings — Schedule (default; ?scope=live and ?scope=upcoming land
 * there too) and Past (?scope=past), migration 106.
 */
export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  return <MeetingsView tab={meetingHubTab(meetingScopeParam(scope))} />;
}
