import { MeetingDetail } from '@/components/meetings/meeting-detail';

/** /meetings/[id] — one meeting's details and Join (migration 106). */
export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MeetingDetail key={id} meetingId={id} />;
}
