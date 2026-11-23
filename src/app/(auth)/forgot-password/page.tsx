import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, KeyRound } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// No form on purpose. This CRM sends no mail, so a reset link could not
// arrive (and had no page to land on); an administrator sets a new
// password in Settings -> Members (migration 140). Asking for an email
// here would also say which addresses have a login.
export default function ForgotPasswordPage() {
  const t = useTranslations('ForgotPasswordPage');
  return (
    <div className="auth-backdrop min-h-app flex items-center justify-center px-4 dark:bg-none">
      <Card className="border-border bg-card shadow-foreground/5 w-full max-w-md py-6 shadow-xl dark:shadow-black/40">
        <CardHeader className="items-center text-center">
          <div className="bg-primary-soft mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <KeyRound className="text-primary h-6 w-6" />
          </div>
          <CardTitle className="text-foreground text-xl">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t('steps')}</p>
          <Link
            href="/login"
            className="text-muted-foreground hover:text-foreground mt-6 flex items-center justify-center gap-2 text-sm"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
            {t('backToSignIn')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
