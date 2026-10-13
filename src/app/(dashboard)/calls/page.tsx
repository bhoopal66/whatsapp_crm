import { CallsView } from '@/components/calls/calls-view';

/**
 * /calls — Missed calls (default), Call log (?tab=log) and, for team
 * leaders and up, By person (?tab=people), module 015.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <CallsView tab={tab === 'log' || tab === 'people' ? tab : 'missed'} />;
}
