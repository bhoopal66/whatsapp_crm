// ============================================================
// /f/[token] — the hosted public web form (migration 249,
// docs/web-form.md). A server component with no client script: the
// <form> posts urlencoded to /api/public/web-form/<token>, which answers
// with a 303 back here (?sent=1, or ?error=<code>). An unknown, switched
// off or archived form is a plain 404, the same for all three. Nothing
// about the workspace is shown.
// ============================================================

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CheckCircle2, CircleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { loadPublicForm } from '@/lib/web-form/server';
import {
  FIELD_LIMITS,
  HONEYPOT_FIELD,
  isWellFormedToken,
} from '@/lib/web-form/submission';

export const dynamic = 'force-dynamic';

const ERRORS = [
  'phone_required',
  'bad_phone',
  'bad_email',
  'too_long',
] as const;
type FormError = (typeof ERRORS)[number];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('WebForm');
  return { title: t('pageTitle') };
}

export default async function WebFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isWellFormedToken(token)) notFound();
  const form = await loadPublicForm(supabaseAdmin(), token).catch(() => null);
  if (!form) notFound();

  const t = await getTranslations('WebForm');
  const query = await searchParams;
  const sent = query.sent === '1';
  const errorParam = typeof query.error === 'string' ? query.error : null;
  const error = ERRORS.includes(errorParam as FormError)
    ? (errorParam as FormError)
    : null;

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-foreground text-xl font-semibold">
            {t('heading')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('intro')}</p>
        </div>

        {sent ? (
          <div
            role="status"
            className="bg-success-soft text-success flex items-start gap-2 rounded-md p-3 text-sm"
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t('sent')}</span>
          </div>
        ) : (
          <form
            method="post"
            action={`/api/public/web-form/${token}`}
            className="space-y-4"
          >
            {error ? (
              <div
                role="alert"
                className="bg-destructive-soft text-destructive flex items-start gap-2 rounded-md p-3 text-sm"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{t(`errors.${error}`)}</span>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="wf-name">{t('name')}</Label>
              <Input
                id="wf-name"
                name="name"
                autoComplete="name"
                maxLength={FIELD_LIMITS.name}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-phone">{t('phone')}</Label>
              <Input
                id="wf-phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                maxLength={FIELD_LIMITS.phone}
                placeholder="+971 50 123 4567"
                aria-invalid={
                  error === 'bad_phone' || error === 'phone_required'
                }
              />
              <p className="text-muted-foreground text-xs">{t('phoneHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-email">{t('email')}</Label>
              <Input
                id="wf-email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={FIELD_LIMITS.email}
                aria-invalid={error === 'bad_email'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-message">{t('message')}</Label>
              <Textarea
                id="wf-message"
                name="message"
                rows={4}
                maxLength={FIELD_LIMITS.message}
              />
            </div>
            {/* Honeypot: hidden from people and screen readers; a bot
                that fills every field is answered "sent" and ignored. */}
            <div
              aria-hidden
              className="absolute -left-[10000px] h-px w-px overflow-hidden"
            >
              <label htmlFor="wf-website">Website</label>
              <input
                id="wf-website"
                name={HONEYPOT_FIELD}
                type="text"
                tabIndex={-1}
                autoComplete="off"
              />
            </div>
            <Button type="submit" className="w-full">
              {t('submit')}
            </Button>
            <p className="text-muted-foreground text-xs">{t('privacy')}</p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
