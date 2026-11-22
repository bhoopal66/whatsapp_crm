'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { cachedQuery } from '@/lib/client-cache';
import { registerDocTypes, type DocType } from '@/lib/desk/doc-types';

import { deskApi } from './desk-api';

/**
 * The workspace's document types for the desk's pick lists. Slow-moving
 * reference data, so cached (keyed by workspace, as the cache requires);
 * on arrival the labels are registered so `docTypeLabel` shows them
 * everywhere on the desk. Until then (or if the call fails) the built-in
 * names and a readable form of the key are used.
 */
export function useDocTypes(): DocType[] {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<{
    account: string | null;
    types: DocType[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    void cachedQuery(`desk-doc-types:${accountId ?? ''}`, 5 * 60_000, () =>
      deskApi.docTypes().then((r) => {
        if (!r.ok) throw new Error(r.error);
        return r.data;
      })
    )
      .then((types) => {
        if (!live) return;
        registerDocTypes(types);
        setLoaded({ account: accountId, types });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accountId]);
  return loaded && loaded.account === accountId ? loaded.types : [];
}
