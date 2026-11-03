'use client';

// ============================================================
// Edit another member's name and login email (Settings → Members,
// migration 167).
//
// The form applies the route's own rule (`memberDetailsProblem` over
// `normalizeMemberDetails`), so the two refuse the same input; GoTrue
// can still refuse an address another login holds (409). The database
// decides who may edit whose details (`authorize_member_details_change`);
// the roster offers the button only where `canEditDetailsOf` says it can
// pass in this workspace.
// ============================================================

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, UserPen } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  MAX_MEMBER_NAME_LENGTH,
  memberDetailsProblem,
  normalizeMemberDetails,
  type MemberDetailsProblem,
} from '@/lib/account/member-details';

export interface DetailsDialogMember {
  user_id: string;
  full_name: string;
  email: string;
}

export function MemberDetailsDialog({
  member,
  onClose,
  onSaved,
}: {
  /** The person whose details are being edited; null closes the dialog. */
  member: DetailsDialogMember | null;
  onClose: () => void;
  /** The details as the server saved them. */
  onSaved: (member: DetailsDialogMember) => void;
}) {
  const t = useTranslations('Settings.members.details');
  const [name, setName] = useState(member?.full_name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [nameEdited, setNameEdited] = useState(false);
  const [emailEdited, setEmailEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The request in flight, so a reply can tell whether it still belongs
  // to what is on screen.
  const requestRef = useRef(0);

  // Every opening starts from that person's saved details. The roster
  // passes a fresh object each render, so this compares the person, and
  // closing (null) in between makes reopening the same person reset too.
  // Closing leaves the fields alone so they don't blank mid-animation.
  const [shownId, setShownId] = useState<string | null>(
    member?.user_id ?? null
  );
  const memberId = member?.user_id ?? null;
  if (memberId !== shownId) {
    setShownId(memberId);
    if (member) {
      setName(member.full_name);
      setEmail(member.email);
      setNameEdited(false);
      setEmailEdited(false);
      setError(null);
    }
  }

  const details = normalizeMemberDetails({ full_name: name, email });
  const saved = member ? normalizeMemberDetails(member) : null;
  const problem = memberDetailsProblem(details);
  const unchanged =
    !saved ||
    (details.full_name === saved.full_name && details.email === saved.email);
  const canSubmit = !!member && !problem && !unchanged && !submitting;

  // The rule reports only the first problem, and a name problem would
  // hide an email one, so each field asks about itself.
  const nameProblem: MemberDetailsProblem | null =
    nameEdited && problem?.startsWith('name') ? problem : null;
  const emailOnly = memberDetailsProblem({
    full_name: 'x',
    email: details.email,
  });
  const emailProblem: MemberDetailsProblem | null = emailEdited
    ? emailOnly
    : null;

  async function handleSave() {
    if (!member || !canSubmit) return;
    const request = ++requestRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/account/members/${encodeURIComponent(member.user_id)}/details`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(details),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (request !== requestRef.current) return;
      if (!res.ok) {
        setError(
          typeof payload?.error === 'string' ? payload.error : t('failed')
        );
        return;
      }
      const next: DetailsDialogMember = {
        user_id: member.user_id,
        full_name:
          typeof payload?.member?.full_name === 'string'
            ? payload.member.full_name
            : details.full_name,
        email:
          typeof payload?.member?.email === 'string'
            ? payload.member.email
            : details.email,
      };
      toast.success(t('done', { name: next.full_name }));
      onSaved(next);
      onClose();
    } catch {
      if (request === requestRef.current) setError(t('failed'));
    } finally {
      if (request === requestRef.current) setSubmitting(false);
    }
  }

  // While a save is in flight the dialog stays open: closing it would
  // hide whether the change landed, and let its late reply speak for the
  // next person opened.
  function close() {
    if (submitting) return;
    requestRef.current++;
    onClose();
  }

  const problemText = (p: MemberDetailsProblem) =>
    t(`problem.${p}`, { max: MAX_MEMBER_NAME_LENGTH });

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title', { name: member?.full_name || member?.email || '' })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div className="space-y-2">
            <Label
              htmlFor="member-details-name"
              className="text-muted-foreground"
            >
              {t('nameLabel')}
            </Label>
            <Input
              id="member-details-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
                setError(null);
              }}
              maxLength={MAX_MEMBER_NAME_LENGTH}
              autoComplete="off"
              aria-invalid={nameProblem !== null}
              className="border-border text-foreground"
            />
            {nameProblem ? (
              <p className="text-destructive text-xs">
                {problemText(nameProblem)}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="member-details-email"
              className="text-muted-foreground"
            >
              {t('emailLabel')}
            </Label>
            <Input
              id="member-details-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailEdited(true);
                setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={emailProblem !== null}
              className="border-border text-foreground"
            />
            <p
              className={
                emailProblem
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {emailProblem ? problemText(emailProblem) : t('emailNote')}
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive-soft text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {error}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!canSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPen className="size-4" />
            )}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
