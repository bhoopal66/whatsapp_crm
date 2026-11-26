'use client';

// Names the WhatsApp numbers only owners and admins can use once a person
// or a team is gone, or a team is saved with other people (314). Read once
// per person or team; a failed read shows nothing, the numbers screen still says it afterwards.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import {
  numbersLeftToAdmins,
  type AccessRow,
  type TeamRoster,
} from '@/lib/whatsapp/team-allocation';

type Leaving = { userId: string } | { teamId: string } | { team: TeamRoster };

interface Row extends AccessRow {
  label: string | null;
  waba_id: string | null;
  phone_number_id: string;
}

interface Access {
  numbers: Row[];
  teams: TeamRoster[];
  gone: Set<string>;
}

async function readAccess(): Promise<Access> {
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
  return { numbers: numbers.channels, teams: teams.teams, gone };
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
      : `t:${'team' in leaving ? leaving.team.id : leaving.teamId}`
    : null;
  const [found, setFound] = useState<{ key: string; access: Access } | null>(
    null
  );

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    readAccess()
      .then((access) => {
        if (!cancelled) setFound({ key, access });
      })
      .catch((err) => console.error('[numbers-left-to-admins]', err));
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!leaving || !found || found.key !== key) return null;
  const { numbers, teams, gone } = found.access;
  const names = numbersLeftToAdmins(
    numbers,
    teams,
    leaving,
    (id) => !gone.has(id)
  ).map(channelDisplayName);
  if (names.length === 0) return null;
  return (
    <Tag className="text-warning text-sm">
      {t('leftToAdmins', { names: names.join(', ') })}
    </Tag>
  );
}
