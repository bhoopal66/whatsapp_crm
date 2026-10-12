'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';

import { DealRoomView } from '@/components/deal-rooms/room-view';

/** One deal room: the group chat, or (?tab=notes) the Team notes. */
function RoomScreen() {
  const { roomId } = useParams<{ roomId: string }>();
  return <DealRoomView key={roomId} roomId={roomId} />;
}

export default function DealRoomPage() {
  return (
    <Suspense fallback={null}>
      <RoomScreen />
    </Suspense>
  );
}
