'use client';

// The browser softphone (module 015), mounted once inside CallProvider.
// It loads the operator-hosted Linkus SDK (linkus-loader.ts) only for a
// person whose softphone is on, on a PBX with SDK credentials, and only
// when NEXT_PUBLIC_LINKUS_SDK_URL is set; then registers the adapter, so
// the call screens answer and control calls in this tab. Anything else
// (or any failure here) leaves them in desk-phone mode. Renders nothing:
// the status goes to the provider's `softphoneState`.
//
// The adapter is destroyed when this unmounts (sign-out and a workspace
// switch both leave the dashboard) and on pagehide (tab closed), so the
// PBX login is not left registered to a dead tab.

import { useEffect } from 'react';
import {
  createLinkusAdapter,
  fetchSoftphoneSignature,
  type LinkusAdapter,
  type SoftphoneMedia,
} from '@/lib/pbx/linkus-adapter';
import {
  linkusSdkUrl,
  loadLinkusSdk,
  shouldLoadSoftphone,
} from '@/lib/pbx/linkus-loader';
import { SOFTPHONE_OFF } from '@/lib/pbx/linkus-state';
import { useCalls } from './call-provider';

/** One <audio> per call for the remote side. */
function browserAudio(): SoftphoneMedia {
  const els = new Map<string, HTMLAudioElement>();
  return {
    play(callId, stream) {
      let el = els.get(callId);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        els.set(callId, el);
      }
      if (el.srcObject !== stream) el.srcObject = stream as MediaStream;
      void el.play().catch(() => {});
    },
    stop(callId) {
      const el = els.get(callId);
      if (!el) return;
      el.pause();
      el.srcObject = null;
      els.delete(callId);
    },
  };
}

export function SoftphoneMount() {
  const calls = useCalls();
  const me = calls?.me ?? null;
  const register = calls?.registerSoftphone;
  const report = calls?.reportSoftphone;
  const url = linkusSdkUrl();
  const extension = me?.extension ?? null;
  const connectionId = me?.connectionId ?? null;
  const enabled = me?.softphoneEnabled ?? false;
  const available = me?.softphoneAvailable ?? false;

  useEffect(() => {
    const flags = { softphoneEnabled: enabled, softphoneAvailable: available };
    if (!shouldLoadSoftphone(flags, url) || !register || !report) return;
    let live = true;
    let adapter: LinkusAdapter | null = null;
    let unregister = () => {};
    let unsubscribe = () => {};
    report({ status: 'loading', extension, error: null });
    loadLinkusSdk(flags, url)
      .then((sdk) => {
        if (!live || !sdk) return;
        const a = createLinkusAdapter({
          sdk,
          signature: () => fetchSoftphoneSignature(),
          extension,
          media: browserAudio(),
        });
        adapter = a;
        unsubscribe = a.subscribe(() => report(a.getState()));
        unregister = register(a);
        return a.start();
      })
      .catch((err: unknown) => {
        if (live)
          report({
            status: 'error',
            extension,
            error: err instanceof Error ? err.message : String(err),
          });
      });
    const onHide = () => adapter?.destroy();
    window.addEventListener('pagehide', onHide);
    return () => {
      live = false;
      window.removeEventListener('pagehide', onHide);
      unsubscribe();
      unregister();
      adapter?.destroy();
      report(SOFTPHONE_OFF);
    };
  }, [enabled, available, url, extension, connectionId, register, report]);

  return null;
}
