import { Suspense } from 'react';

import { CasesInbox } from '@/components/cases/cases-inbox';

/**
 * /cases — the coordinator inbox (module 019). The filters live in the
 * URL (useSearchParams), hence the Suspense boundary.
 */
export default function CasesPage() {
  return (
    <Suspense
      fallback={<div className="bg-muted m-6 h-40 animate-pulse rounded-xl" />}
    >
      <CasesInbox />
    </Suspense>
  );
}
