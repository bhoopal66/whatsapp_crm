'use client';

import { useParams } from 'next/navigation';

import { ChannelView } from '@/components/chat/channel-view';
import { Composer } from '@/components/chat/composer';
import { MessageMarksProvider } from '@/components/chat/message-marks';

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  return (
    <MessageMarksProvider key={channelId} channelId={channelId}>
      <ChannelView
        channelId={channelId}
        footer={<Composer key={channelId} channelId={channelId} />}
      />
    </MessageMarksProvider>
  );
}
