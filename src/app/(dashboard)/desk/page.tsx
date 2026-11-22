import { Suspense } from 'react';

import { DeskView } from '@/components/desk/desk-view';

export default function DeskPage() {
  // DeskView reads `?tab=`, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <DeskView />
    </Suspense>
  );
}
