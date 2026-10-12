import { toast } from 'sonner';

/**
 * Click-to-call a contact (POST /api/pbx/calls/dial): the PBX rings the
 * caller's own extension first. 409s carry a code the toast names.
 */
export async function dialContact(
  contactId: string,
  t: (key: 'dialing' | 'noExtension' | 'doNotContact' | 'dialFailed') => string
): Promise<boolean> {
  const res = await fetch('/api/pbx/calls/dial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId }),
  }).catch(() => null);
  if (res?.ok) {
    toast.success(t('dialing'));
    return true;
  }
  const body = res ? await res.json().catch(() => null) : null;
  toast.error(
    body?.code === 'no_extension'
      ? t('noExtension')
      : body?.code === 'do_not_contact'
        ? t('doNotContact')
        : t('dialFailed')
  );
  return false;
}
