import { CallsView } from '@/components/calls/calls-view';
import { callsTab } from '@/lib/pbx/call-ui';

/**
 * /calls — Missed calls (default), Call log (?tab=log), for team
 * leaders and up By person (?tab=people), and for owners and admins
 * Unrouted (?tab=unrouted), module 015.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <CallsView tab={callsTab(tab)} />;
}
