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
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { shouldOfferPush } from '@/lib/push/client';

const DISMISS_KEY = 'taamul.push-prompt-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return true; // No storage: never nag on every page load.
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Storage unavailable: the banner just comes back next load.
  }
}

/**
 * One-time "Turn on notifications" banner in the dashboard shell, shown
 * while this browser can take push and has never been asked. Also
 * registers the service worker on every dashboard load and follows a
 * notification click the worker could not navigate itself.
 */
export function PushPrompt() {
  const t = useTranslations('PushNotifications');
  const router = useRouter();
  const push = usePushSubscription();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // localStorage exists only after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: unknown } | null;
      if (
        data?.type === 'push:navigate' &&
        typeof data.url === 'string' &&
        data.url.startsWith('/') &&
        !data.url.startsWith('//')
      ) {
        router.push(data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  if (
    push.support === null ||
    !shouldOfferPush(push.support, push.permission, dismissed)
  ) {
    return null;
  }

  const dismiss = () => {
    writeDismissed();
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
