'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { cachedQuery, REFERENCE_CACHE_TTL_MS } from '@/lib/client-cache';
import { parseBanks, type CaseBankOption } from '@/lib/cases/ui';

/**
 * The workspace's case banks (`GET /api/cases/config/banks`, agent and up);
 * null while loading, [] on any failure. Cached under the same key as the
 * Cases inbox's filter, so the two share one read.
 */
export function useCaseBanks(): CaseBankOption[] | null {
  const { accountId } = useAuth();
  const [banks, setBanks] = useState<CaseBankOption[] | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    cachedQuery(`case-banks:${accountId}`, REFERENCE_CACHE_TTL_MS, async () => {
      const res = await fetch('/api/cases/config/banks', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      return parseBanks(await res.json());
    })
      .catch(() => [] as CaseBankOption[])
      .then((list) => {
        if (live) setBanks(list);
      });
    return () => {
      live = false;
    };
  }, [accountId]);
  return banks;
}
