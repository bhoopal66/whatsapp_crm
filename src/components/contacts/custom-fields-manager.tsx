'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { ErrorState } from '@/components/dashboard/error-state';
import {
  checkFieldName,
  deleteField,
  loadFieldList,
  renameField,
  type FieldList,
} from '@/lib/contacts/custom-fields';
import type { CustomField } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  const t = useTranslations('Contacts.customFields');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create / rename / delete account-wide custom contact field definitions.
 * Per-contact values are edited elsewhere (contact detail → Custom Fields);
 * this only manages the field catalogue. Admin+ gated by the caller — the
 * `custom_fields` RLS also rejects non-admin writes as defense in depth.
 */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.customFields');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [list, setList] = useState<FieldList>({ status: 'loading' });
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // A second Enter lands before `creating` re-renders; the ref is the guard.
  const creatingRef = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    if (!accountId) return;
    setList({ status: 'loading' });
    setList(await loadFieldList(supabase));
  }, [supabase, accountId]);

  // Load the field list on mount once the account is known. The setters
  // inside fetchFields run after the Supabase await — not synchronously in
  // the effect body — so the cascade the lint rule warns about doesn't apply.
  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchFields();
    }
  }, [accountId, fetchFields]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creatingRef.current) return;
    if (!accountId || !user) {
      toast.error(t('toastNoAccount'));
      return;
    }
    const check = checkFieldName(list, name);
    if (check === 'unknown') return; // Not read: the panel says so.
    if (check === 'taken') {
      toast.error(t('toastDuplicate', { name }));
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    let error;
    try {
      ({ error } = await supabase.from('custom_fields').insert({
        field_name: name,
        field_type: 'text',
        user_id: user.id,
        account_id: accountId,
      }));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }

    if (error) {
      toast.error(t('toastCreateFailed'));
      return;
    }
    toast.success(t('toastCreated', { name }));
    setNewName('');
    await fetchFields();
  }

  /** Returns true on success so the row can keep the new name, false so it
   *  reverts to the previous one. No-ops (blank / unchanged) count as success. */
  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;
    const check = checkFieldName(list, name, field.id);
    if (check === 'unknown') return false;
    if (check === 'taken') {
      toast.error(t('toastDuplicate', { name }));
      return false;
    }
    setBusyId(field.id);
    const error = await renameField(supabase, field.id, name);
    setBusyId(null);
    if (error) toast.error(t(error));
    if (error === 'toastRenameFailed') return false;
    // Also after a rename that found no row: it may be gone.
    await fetchFields();
    return error === null;
  }

  async function handleDelete(field: CustomField) {
    if (!window.confirm(t('deleteConfirm', { name: field.field_name }))) {
      return;
    }
    setBusyId(field.id);
    const error = await deleteField(supabase, field.id);
    setBusyId(null);
    if (error) toast.error(t(error));
    else toast.success(t('toastDeleted', { name: field.field_name }));
    if (error !== 'toastDeleteFailed') await fetchFields();
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreate();
            }
          }}
          placeholder={t('fieldName')}
          className="text-foreground"
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newName.trim() || list.status !== 'ready'}
          className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {t('addField')}
        </Button>
      </div>

      {/* List */}
      <div className="border-border max-h-72 overflow-y-auto rounded-md border">
        {list.status === 'loading' ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : list.status === 'failed' ? (
          <ErrorState
            message={t('loadFailed')}
            onRetry={() => void fetchFields()}
            className="m-2"
          />
        ) : list.fields.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {list.fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row. Controlled local state lets us commit on blur /
 *  Enter and cleanly revert to the last saved name when a rename fails. */
function FieldRow({
  field,
  busy,
  onRename,
  onDelete,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
}) {
  const t = useTranslations('Contacts.customFields');
  const [name, setName] = useState(field.field_name);

  async function commit() {
    if (name.trim() === field.field_name) {
      setName(field.field_name); // normalise any whitespace-only edit
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <Input
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={t('renameAria', { name: field.field_name })}
        className="focus:border-primary text-foreground hover:border-border h-8 border-transparent bg-transparent"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={() => onDelete(field)}
        title={t('deleteTitle')}
        className="text-muted-foreground hover:text-destructive shrink-0"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </Button>
    </li>
  );
}
