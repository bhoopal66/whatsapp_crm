'use client';

// Names the WhatsApp numbers only owners and admins can use once a person
// or a team is gone (314). Read when the dialog opens; a failed read shows
// nothing, the numbers screen still says it afterwards.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import {
  numbersLeftToAdmins,
  type AccessRow,
  type TeamRoster,
} from '@/lib/whatsapp/team-allocation';

type Leaving = { userId: string } | { teamId: string };

interface Row extends AccessRow {
  label: string | null;
  waba_id: string | null;
  phone_number_id: string;
}

async function readNames(leaving: Leaving): Promise<string[]> {
  const [numbers, teams, members] = await Promise.all(
    [
      '/api/whatsapp/channels',
      '/api/account/teams',
      '/api/account/members',
    ].map(async (url) => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(url);
      return res.json();
    })
  );
  const gone = new Set(
    (
      members.members as Array<{
        user_id: string;
        deactivated_at: string | null;
      }>
    )
      .filter((m) => m.deactivated_at)
      .map((m) => m.user_id)
  );
  return numbersLeftToAdmins(
    numbers.channels as Row[],
    teams.teams as TeamRoster[],
    leaving,
    (id) => !gone.has(id)
  ).map(channelDisplayName);
}

export function NumbersLeftToAdmins({
  leaving,
  as: Tag = 'p',
}: {
  leaving: Leaving | null;
  as?: 'p' | 'li';
}) {
  const t = useTranslations('Settings.numbers');
  const key = leaving
    ? 'userId' in leaving
      ? `u:${leaving.userId}`
      : `t:${leaving.teamId}`
    : null;
  const [found, setFound] = useState<{ key: string; names: string[] } | null>(
    null
  );

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const id = key.slice(2);
    readNames(key.startsWith('u:') ? { userId: id } : { teamId: id })
      .then((names) => {
        if (!cancelled) setFound({ key, names });
      })
      .catch((err) => console.error('[numbers-left-to-admins]', err));
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!found || found.key !== key || found.names.length === 0) return null;
  return (
    <Tag className="text-warning text-sm">
      {t('leftToAdmins', { names: found.names.join(', ') })}
    </Tag>
  );
}
