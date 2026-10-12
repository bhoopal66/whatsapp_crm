import { ChatLayout } from '@/components/chat/chat-layout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ChatLayout>{children}</ChatLayout>;
}
