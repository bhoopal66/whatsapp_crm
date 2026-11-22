// ============================================================
// /f/[token] layout — the public web form (migration 249). Outside
// (auth) and (dashboard): visitors are anonymous strangers, and the
// middleware gates neither /f nor /api/public.
//
// Referrer-Policy same-origin: the form's token is its address, so no
// other site the page loads from may receive it. Not no-referrer: under
// no-referrer a browser sends `Origin: null` with the form's own POST
// (Fetch: serializing a request origin), which the post route rightly
// refuses, so no real browser could submit. Not indexed.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  referrer: 'same-origin',
  robots: { index: false, follow: false },
};

export default function WebFormLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background min-h-app flex items-start justify-center px-4 py-10 sm:items-center">
      {children}
    </div>
  );
}
