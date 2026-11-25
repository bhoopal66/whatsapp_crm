'use client';

// "Create contact" for an unknown caller (module 015), shared by the
// ringing card and the in-call window so both link the same way.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ContactForm } from '@/components/contacts/contact-form';
import { useCalls } from './call-provider';

/** The call a "Create contact" form was opened for. */
export interface NewCaller {
  key: string;
  connectionId: string;
  pbxCallId: string;
  phone: string;
}

/**
 * The form (render it outside the window, so a call answered, declined
 * or missed while it is open does not lose what was typed) and `open`.
 */
export function useNewCallerForm() {
  const calls = useCalls();
  const t = useTranslations('PbxCall');
  const [creating, setCreating] = useState<NewCaller | null>(null);

  // The card shows the new contact, and the in-call panel links an
  // answered call to it (picks). A call still live is matched by its
  // number when it ends; one that ended while the form was open was
  // matched before the contact existed, so the route links it.
  const linkNewCaller = async (c: NewCaller, contactId: string) => {
    calls?.pick(c.key, contactId);
    const res = await fetch('/api/pbx/calls/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: c.connectionId,
        pbxCallId: c.pbxCallId,
        contactId,
      }),
    }).catch(() => null);
    if (!res?.ok) return void toast.error(t('linkFailed'));
    // 200 { linked: false }: not a call of mine, or it has a customer.
    const body = (await res.json().catch(() => null)) as {
      linked?: unknown;
      atEnd?: unknown;
    } | null;
    // Still ringing: its number is matched to the contact when it ends.
    if (body?.atEnd === true) return;
    if (body?.linked !== true) toast.warning(t('linkSkipped'));
  };

  // Floating (no backdrop, non-modal, outside presses keep it open), so
  // Answer and Decline, and the call window's controls, stay clickable
  // beside it.
  const form = (
    <ContactForm
      floating
      open={creating !== null}
      onOpenChange={(open) => {
        if (!open) setCreating(null);
      }}
      initialPhone={creating?.phone}
      onSaved={(contactId) => {
        if (creating && contactId) void linkNewCaller(creating, contactId);
      }}
    />
  );
  return { form, open: setCreating };
}
