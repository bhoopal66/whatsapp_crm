'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { CallButton } from '@/components/pbx/call-button';
import { useCalls } from '@/components/pbx/call-provider';
import { useAuth } from '@/hooks/use-auth';
import { dmCallTarget } from '@/lib/chat/dm-call';
import { dmOthers } from '@/lib/chat/view';
import { outboundCallsEnabled } from '@/lib/pbx/outbound';
import { createClient } from '@/lib/supabase/client';

/** Call button for a 1:1 DM whose other person has an extension. */
export function DmCallButton(props: {
  kind: string;
  dmMemberIds: readonly string[];
}) {
  // Calling from the CRM switched off: no button, and no extension query.
  if (!outboundCallsEnabled()) return null;
  return <DmCall {...props} />;
}

function DmCall({
  kind,
  dmMemberIds,
}: {
  kind: string;
  dmMemberIds: readonly string[];
}) {
  const t = useTranslations('ChatCalls');
  const { user, accountRole } = useAuth();
  const me = useCalls()?.me ?? null;
  const hasPhone = !!me;
  const connectionId = me?.connectionId ?? null;
  const userId = user?.id ?? null;
  const others = userId ? dmOthers(dmMemberIds, userId) : [];
  const peer = others.length === 1 ? others[0] : null;
  const [ext, setExt] = useState<{ peer: string; map: Map<string, string> }>();

  useEffect(() => {
    if (kind !== 'dm' || !peer || !hasPhone) return;
    let cancelled = false;
    let q = createClient()
      .from('pbx_extensions')
      .select('extension, user_id')
      .eq('user_id', peer);
    if (connectionId) q = q.eq('connection_id', connectionId);
    q.limit(1).then(({ data }) => {
      if (cancelled) return;
      const row = (data ?? [])[0] as
        { extension: string; user_id: string } | undefined;
      setExt({
        peer,
        map: new Map(row ? [[row.user_id.toLowerCase(), row.extension]] : []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, peer, hasPhone, connectionId]);

  const number = dmCallTarget({
    kind,
    others,
    extensionsByUser: ext && ext.peer === peer ? ext.map : new Map(),
    hasPhone,
    role: accountRole,
  });
  if (!number) return null;
  return <CallButton number={number} label={t('callPerson')} />;
}
