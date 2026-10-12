'use client';

import { useParams } from 'next/navigation';

import { ChannelView } from '@/components/chat/channel-view';

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  return <ChannelView key={channelId} channelId={channelId} />;
}
