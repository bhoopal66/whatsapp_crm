'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { useAuth } from '@/hooks/use-auth';
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { pushPromptDismissKey, shouldShowPushPrompt } from '@/lib/push/client';
import { createPushNavigator } from '@/lib/push/navigate';

/**
 * The browser-wide key the banner used before dismissal was per person.
 * Still honoured: whoever said "Not now" then is not asked again.
 */
const LEGACY_DISMISS_KEY = 'taamul.push-prompt-dismissed';

function readDismissed(userId: string): boolean {
  try {
    return (
      window.localStorage.getItem(pushPromptDismissKey(userId)) === '1' ||
      window.localStorage.getItem(LEGACY_DISMISS_KEY) === '1'
    );
  } catch {
    return true; // No storage: never nag on every page load.
  }
}

function writeDismissed(userId: string) {
  try {
    window.localStorage.setItem(pushPromptDismissKey(userId), '1');
  } catch {
    // Storage unavailable: the banner just comes back next load.
  }
}

/**
 * One-time "Turn on notifications" banner in the dashboard shell, shown
 * while push is configured on this install, this browser can take it,
 * has never been asked and has no subscription, and the person has not
 * said "Not now" (remembered per person on this browser). Never for a
 * bank guest. Also registers the service worker on every dashboard load
 * and follows notification clicks (lib/push/navigate.ts).
 */
export function PushPrompt() {
  const t = useTranslations('PushNotifications');
  const router = useRouter();
  const { user, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const push = usePushSubscription();
  const [dismissed, setDismissed] = useState(true);
  const [serverConfigured, setServerConfigured] = useState<boolean | null>(
    null
  );

  useEffect(() => {
    // localStorage exists only after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(userId ? readDismissed(userId) : true);
  }, [userId]);

  // Asked only when the banner could otherwise show: no request at all
  // for everyone who already answered.
  const askServer =
    !isBankGuest &&
    !dismissed &&
    push.support === 'supported' &&
    push.permission === 'default';
  useEffect(() => {
    if (!askServer || serverConfigured !== null) return;
    let cancelled = false;
    fetch('/api/push/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { publicKey?: string | null } | null) => {
        if (!cancelled) setServerConfigured(!!body?.publicKey);
      })
      .catch(() => {
        if (!cancelled) setServerConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [askServer, serverConfigured]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const onMessage = createPushNavigator((url) => router.push(url));
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  if (
    !userId ||
    !shouldShowPushPrompt({
      support: push.support,
      permission: push.permission,
      subscribed: push.state === 'on',
      dismissed,
      serverConfigured,
      bankGuest: isBankGuest,
    })
  ) {
    return null;
  }

  const dismiss = () => {
    writeDismissed(userId);
    setDismissed(true);
  };

  const turnOn = async () => {
    const result = await push.subscribe();
    dismiss();
    if (result === 'on') toast.success(t('turnedOn'));
    else if (result === 'not_configured') toast.error(t('notConfigured'));
    else if (result === 'denied') toast.error(t('permissionDenied'));
    else toast.error(t('subscribeFailed'));
  };

  return (
    <Alert className="mb-4">
      <BellRing />
      <AlertTitle>{t('bannerTitle')}</AlertTitle>
      <AlertDescription>{t('bannerBody')}</AlertDescription>
      <AlertAction className="flex gap-2">
        <Button size="sm" disabled={push.busy} onClick={() => void turnOn()}>
          {t('bannerAction')}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t('bannerDismiss')}
        </Button>
      </AlertAction>
    </Alert>
  );
}
