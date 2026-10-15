import { MeetingRoom } from '@/components/meetings/room/meeting-room';

/** /meetings/[id]/room — the in-browser call (migration 106). */
export default async function MeetingRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MeetingRoom key={id} meetingId={id} />;
}
