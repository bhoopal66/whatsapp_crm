'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info, Loader2, ShieldCheck } from 'lucide-react';

import { useChatPermissions } from '@/hooks/use-chat-permissions';
import { createClient } from '@/lib/supabase/client';
import { rolePermissionRows, setPermissions } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import {
  CHAT_CAPABILITIES,
  CHAT_ROLE_CLASSES,
  channelCreationLimit,
  deniedFromMatrix,
  isDeniable,
  openPermissionMatrix,
  RECOMMENDED_DENIED,
  type ChatCapability,
  type ChatRoleClass,
  type PermissionMatrix,
} from '@/lib/chat/permissions';
import {
  hasMatrixChanges,
  matrixChanges,
  matrixFromDenied,
} from '@/lib/chat/permissions-form';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Supabase = ReturnType<typeof createClient>;

/**
 * Settings → Team chat → Role permissions (migration 157): which role
 * may do what in team chat. A ticked cell is allowed; the save sends the
 * whole denied set. Owners are never restricted, and a bank guest can be
 * restricted only in GUEST_CAPABILITIES (the rest they never have).
 */
export function PermissionsCard({
  supabase,
  accountId,
}: {
  supabase: Supabase;
  accountId: string | null;
}) {
  const t = useTranslations('Settings.teamChat.permissions');
  const tErrors = useTranslations('Chat.errors');
  const { reload } = useChatPermissions();
  const [saved, setSaved] = useState<PermissionMatrix | null>(null);
  const [draft, setDraft] = useState<PermissionMatrix | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    rolePermissionRows(supabase, accountId)
      .then((denied) => {
        if (off) return;
        const m = matrixFromDenied(denied);
        setSaved(m);
        setDraft(m);
      })
      .catch(() => {
        if (!off) setLoadFailed(true);
      });
    return () => {
      off = true;
    };
  }, [supabase, accountId, attempt]);

  const changes = useMemo(
    () => (saved && draft ? matrixChanges(saved, draft) : null),
    [saved, draft]
  );
  const dirty = !!changes && hasMatrixChanges(changes);

  async function save() {
    if (!accountId || !draft || !dirty) return;
    setSaving(true);
    try {
      await setPermissions(supabase, accountId, deniedFromMatrix(draft));
      setSaved(draft);
      setConfirming(false);
      toast.success(t('saved'));
      await reload().catch(() => undefined);
      // Show what the database holds, not what was sent (a rule it
      // normalised or a concurrent admin's change shows up here).
      try {
        const m = matrixFromDenied(
          await rolePermissionRows(supabase, accountId)
        );
        setSaved(m);
        setDraft(m);
      } catch {
        // Keep the saved draft; the next load corrects it.
      }
    } catch (err) {
      toast.error(
        err instanceof ChatError && err.key !== 'unknown'
          ? tErrors(err.key)
          : t('saveFailed')
      );
    } finally {
      setSaving(false);
    }
  }

  const toggle = (rc: ChatRoleClass, cap: ChatCapability, allowed: boolean) =>
    setDraft((d) => (d ? { ...d, [rc]: { ...d[rc], [cap]: allowed } } : d));

  const confirmSentence = changes
    ? changes.denied.length && changes.allowed.length
      ? t('confirmBoth', {
          denied: changes.denied.length,
          allowed: changes.allowed.length,
        })
      : changes.denied.length
        ? t('confirmDeny', { count: changes.denied.length })
        : t('confirmAllow', { count: changes.allowed.length })
    : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <ShieldCheck className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {loadFailed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : !draft ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </p>
        ) : (
          <>
            {/* The table scrolls inside the card on a phone, never the page. */}
            <div className="border-border max-w-full overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <caption className="sr-only">{t('title')}</caption>
                <thead>
                  <tr className="bg-card-2 border-border border-b">
                    <th
                      scope="col"
                      className="bg-card-2 text-muted-foreground sticky left-0 z-10 px-3 py-2 text-left text-xs font-medium"
                    >
                      {t('capabilityColumn')}
                    </th>
                    {CHAT_ROLE_CLASSES.map((rc) => (
                      <th
                        key={rc}
                        scope="col"
                        className="text-foreground px-2 py-2 text-center text-xs font-semibold"
                      >
                        {t(`classes.${rc}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CHAT_CAPABILITIES.map((cap) => (
                    <tr
                      key={cap}
                      className="border-border border-b last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="bg-card sticky left-0 z-10 max-w-[14rem] px-3 py-2 text-left align-top font-normal"
                      >
                        <span className="text-foreground block text-sm font-medium">
                          {t(`capabilities.${cap}.label`)}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {t(`capabilities.${cap}.description`)}
                        </span>
                      </th>
                      {CHAT_ROLE_CLASSES.map((rc) => (
                        <td key={rc} className="px-2 py-2 text-center">
                          {channelCreationLimit(rc, cap) === 'never' ? (
                            <span
                              className="text-muted-foreground"
                              title={t('channelsNever')}
                            >
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">
                                {t('channelsNever')}
                              </span>
                            </span>
                          ) : isDeniable(rc, cap) ? (
                            <span className="inline-flex flex-col items-center gap-0.5">
                              <Checkbox
                                checked={draft[rc][cap]}
                                onCheckedChange={(checked) =>
                                  toggle(rc, cap, checked === true)
                                }
                                disabled={saving}
                                aria-label={t('cellLabel', {
                                  role: t(`classes.${rc}`),
                                  capability: t(`capabilities.${cap}.label`),
                                })}
                              />
                              {channelCreationLimit(rc, cap) ===
                                'coordinatorsOnly' && (
                                <span className="text-muted-foreground text-[11px] leading-tight whitespace-nowrap">
                                  {t('coordinatorsOnly')}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span
                              className="text-muted-foreground"
                              title={t('notApplicable')}
                            >
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">
                                {t('notApplicable')}
                              </span>
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-lg border p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                <p>{t('ownerNote')}</p>
                <p>{t('channelsNote')}</p>
                <p>{t('guestNote')}</p>
                <p>{t('savedNote')}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('recommendedHint')}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setDraft(matrixFromDenied(RECOMMENDED_DENIED))}
                disabled={saving}
              >
                {t('recommended')}
              </Button>
              <Button
                variant="outline"
                onClick={() => setDraft(openPermissionMatrix())}
                disabled={saving}
              >
                {t('allowAll')}
              </Button>
              <Button
                onClick={() => setConfirming(true)}
                disabled={!dirty || saving}
              >
                {t('save')}
              </Button>
              {dirty && (
                <span className="text-muted-foreground text-xs" role="status">
                  {t('unsaved')}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog
        open={confirming && dirty}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirming(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{confirmSentence}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('confirmSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
