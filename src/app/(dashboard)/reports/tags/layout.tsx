import type { ReactNode } from 'react';

import { ReportAccessLayout } from '@/components/auth/admin-only-layout';

// The chat tag report (migration 255): the owner, or a person the owner
// granted it. chat_tag_report() refuses anyone else as well; this keeps
// the page itself from them.
export default function Layout({ children }: { children: ReactNode }) {
  return <ReportAccessLayout report="chat_tags">{children}</ReportAccessLayout>;
}
