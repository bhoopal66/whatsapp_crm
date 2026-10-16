import { CustomerPage } from '@/components/contacts/customer-page';
import { isFromTeam } from '@/lib/contacts/customer-links';

/** /contacts/[id] — the customer page (module 015). */
export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  return <CustomerPage key={id} contactId={id} fromTeam={isFromTeam(from)} />;
}
