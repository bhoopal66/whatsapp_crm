import { redirect } from 'next/navigation';

import { agentsRedirectHref } from '@/components/settings/settings-sections';

/**
 * AI Agents moved into Settings (`/settings?tab=ai-<tab>`). Old links,
 * bookmarks and `?tab=` deep links land on the same tab there. The
 * admin-only layout beside this page still runs first.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  redirect(agentsRedirectHref((await searchParams).tab));
}
