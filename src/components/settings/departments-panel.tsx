'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  DEPARTMENT_DEFAULTS,
  DEPARTMENTS,
  departmentAfterToggle,
  mergeDepartmentSettings,
  type Department,
  type DepartmentSettings,
} from '@/lib/auth/departments';
import { ErrorState } from '@/components/dashboard/error-state';
import { Switch } from '@/components/ui/switch';

/**
 * Settings -> Departments (migration 192): per department, whether its
 * people's chats go to a separate admin-only inbox, and whether they are
 * kept out of the sales areas. Reads `account_departments` (a missing
 * row is the built-in default) and saves one switch at a time through
 * `set_department_settings`, the department's other one as it is stored
 * at that moment. Owner/admin only (the section's
 * gate, and the RPC).
 */
export function DepartmentsPanel() {
  const t = useTranslations('Settings.departments');
  const { accountId } = useAuth();
  const [settings, setSettings] = useState<Record<
    Department,
    DepartmentSettings
  > | null>(null);
  const [saving, setSaving] = useState<Department | null>(null);
  // A failed load shows no switches: a save sends both columns of a
  // department, so neither may come from the built-in defaults.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from('account_departments')
      .select('department, own_inbox, restricted')
      .eq('account_id', accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[DepartmentsPanel] load error:', error);
          setSettings(null);
          setFailed(true);
          return;
        }
        setSettings(mergeDepartmentSettings(data));
        setFailed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, attempt]);

  async function change(
    department: Department,
    patch: Partial<DepartmentSettings>
  ) {
    if (!accountId) return;
    setSaving(department);
    const supabase = createClient();
    const row = await supabase
      .from('account_departments')
      .select('department, own_inbox, restricted')
      .eq('account_id', accountId)
      .eq('department', department)
      .maybeSingle();
    if (row.error) {
      setSaving(null);
      console.error('[DepartmentsPanel] re-read error:', row.error);
      toast.error(t('rereadFailed'));
      return;
    }
    const next = departmentAfterToggle(department, row.data, patch);
    const { error } = await supabase.rpc('set_department_settings', {
      p_department: department,
      p_own_inbox: next.own_inbox,
      p_restricted: next.restricted,
    });
    setSaving(null);
    if (error) {
      console.error('[DepartmentsPanel] save error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setSettings((s) => s && { ...s, [department]: next });
    toast.success(t('saved', { department: t(`names.${department}`) }));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-foreground text-lg font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>

      {failed ? (
        <ErrorState
          message={t('loadFailed')}
          onRetry={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      ) : !settings ? (
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      ) : (
        <div className="space-y-3">
          {DEPARTMENTS.map((d) => (
            <div
              key={d}
              className="border-border bg-card space-y-3 rounded-lg border p-4"
            >
              <div className="flex items-center gap-2">
                <h3 className="text-foreground text-sm font-medium">
                  {t(`names.${d}`)}
                </h3>
                {saving === d && (
                  <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                )}
              </div>
              {(
                [
                  ['own_inbox', 'ownInbox'],
                  ['restricted', 'restricted'],
                ] as const
              ).map(([field, key]) => (
                <div
                  key={field}
                  className="flex items-start justify-between gap-4"
                >
                  <div>
                    <p
                      id={`dept-${d}-${field}`}
                      className="text-foreground text-sm"
                    >
                      {t(key)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t(`${key}Hint`)}
                      {settings[d][field] === DEPARTMENT_DEFAULTS[d][field]
                        ? ''
                        : ` ${t('customised')}`}
                    </p>
                  </div>
                  <Switch
                    checked={settings[d][field]}
                    disabled={saving !== null}
                    aria-labelledby={`dept-${d}-${field}`}
                    onCheckedChange={(on) =>
                      void change(d, {
                        [field]: on,
                      } as Partial<DepartmentSettings>)
                    }
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
