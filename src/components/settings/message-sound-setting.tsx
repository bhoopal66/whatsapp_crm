'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Play, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import {
  playMessageSound,
  readMessageSoundOn,
  writeMessageSoundOn,
} from '@/components/layout/message-sound';
import { messageSoundKey } from '@/lib/tab-alerts/message-sound';

/**
 * Settings → Notifications: the new-customer-message sound, off by
 * default. Kept in this browser per person (localStorage), read by the
 * shell's UnreadChatsProvider on every message, so it applies at once.
 */
export function MessageSoundSetting() {
  const t = useTranslations('TabAlerts');
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [on, setOn] = useState(false);

  useEffect(() => {
    // localStorage exists only after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOn(userId ? readMessageSoundOn(messageSoundKey(userId)) : false);
  }, [userId]);

  const change = (next: boolean) => {
    if (!userId) return;
    if (!writeMessageSoundOn(messageSoundKey(userId), next)) {
      toast.error(t('saveFailed'));
      return;
    }
    setOn(next);
    toast.success(next ? t('turnedOn') : t('turnedOff'), {
      id: 'message-sound',
    });
  };

  return (
    <div className="border-border bg-card mt-6 space-y-4 rounded-xl border p-4">
      <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
        <Volume2 className="text-muted-foreground size-4" />
        {t('soundTitle')}
      </h3>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="message-sound">{t('soundSwitch')}</Label>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('soundDescription')}
          </p>
        </div>
        <Switch
          id="message-sound"
          checked={on}
          disabled={!userId}
          onCheckedChange={change}
        />
      </div>
      <Button variant="outline" size="sm" onClick={() => playMessageSound()}>
        <Play />
        {t('soundTry')}
      </Button>
    </div>
  );
}
