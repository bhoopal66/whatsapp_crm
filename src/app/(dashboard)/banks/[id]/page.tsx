import { Suspense } from 'react';

import { BankPage } from '@/components/banks/bank-page';

/**
 * /banks/[id] — one bank's internal space (module 019). The tab lives in
 * the URL (useSearchParams), hence the Suspense boundary.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={<div className="bg-muted m-6 h-40 animate-pulse rounded-xl" />}
    >
      <BankPage bankWsId={id} />
    </Suspense>
  );
}
