// ============================================================
// /f/[token] layout — the public web form (migration 249). Outside
// (auth) and (dashboard): visitors are anonymous strangers, and the
// middleware gates neither /f nor /api/public.
//
// Referrer-Policy no-referrer: the form's token is its address; nothing
// the page loads should receive it. Not indexed.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function WebFormLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background min-h-app flex items-start justify-center px-4 py-10 sm:items-center">
      {children}
    </div>
  );
}
