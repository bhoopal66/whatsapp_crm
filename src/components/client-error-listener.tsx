'use client';

import { useEffect } from 'react';

import { reportClientError } from '@/lib/browser-reports/send';

/**
 * Errors no boundary catches: an event handler, a timer, a promise nobody
 * awaited. The error screens report the ones they show.
 */
export function ClientErrorListener() {
  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      reportClientError('error', e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) =>
      reportClientError('rejection', e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
