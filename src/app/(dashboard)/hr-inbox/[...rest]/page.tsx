import { notFound, redirect } from 'next/navigation';

import { legacyHrSubPagePath } from '@/lib/hr/routes';

/**
 * The old HR inbox's sub-pages (`/hr-inbox/tasks`, `/setup`,
 * `/hire-fast`, `/automated-messages`) moved under `/hr`; a saved link
 * is sent on, its query kept. Anything else under /hr-inbox is a 404.
 */
export default async function LegacyHrSubPage({
  params,
  searchParams,
}: {
  params: Promise<{ rest: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ rest }, query] = await Promise.all([params, searchParams]);
  const target = legacyHrSubPagePath(rest);
  if (!target) notFound();
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : []) {
      q.append(key, v);
    }
  }
  const qs = q.toString();
  redirect(qs ? `${target}?${qs}` : target);
}
