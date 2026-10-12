import { CustomerPage } from '@/components/contacts/customer-page';

/** /contacts/[id] — the customer page (module 015). */
export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomerPage key={id} contactId={id} />;
}
