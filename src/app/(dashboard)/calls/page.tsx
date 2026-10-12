import { CallsView } from '@/components/calls/calls-view';

/** /calls — Missed calls (default) and Call log (?tab=log), module 015. */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <CallsView tab={tab === 'log' ? 'log' : 'missed'} />;
}
