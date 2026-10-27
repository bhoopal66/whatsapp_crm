'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { loginDestination, loginFailure } from '@/lib/auth/login-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { UsersRound } from 'lucide-react';

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get('invite');
  const t = useTranslations('LoginPage');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // `?deactivated=1` is where the dashboard sends a session it finds
  // deactivated (migration 069); say why they landed here.
  const [error, setError] = useState<string | null>(() =>
    searchParams.get('deactivated') ? t('deactivated') : null
  );
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The server route checks the lockout before GoTrue sees the
    // password, and sets the session cookies on its answer.
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      // No answer at all: `status` stays 0, the generic message.
    }

    if (status !== 200) {
      // A deactivated member's login is banned in Supabase Auth; the
      // route answers 403 and they get the same message as
      // `?deactivated=1`, not GoTrue's "User is banned".
      const failure = loginFailure(status, body);
      setError(
        failure.key === 'tooManyAttempts'
          ? t('tooManyAttempts', { minutes: failure.minutes })
          : t(failure.key)
      );
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    window.location.assign(loginDestination(searchParams));
  };

  return (
    <div className="auth-backdrop flex min-h-screen items-center justify-center px-4 dark:bg-none">
      <Card className="border-border bg-card shadow-foreground/5 w-full max-w-md py-6 shadow-xl dark:shadow-black/40">
        <CardHeader className="items-center text-center">
          {/* CardHeader is a grid whose single column spans the full
              width, so a fixed-size child lands at the start of it.
              `items-center` on the header only centers the block axis
              — `mx-auto` is what actually centers these horizontally. */}
          {inviteToken ? (
            <div className="bg-primary-soft mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <UsersRound className="text-primary h-6 w-6" />
            </div>
          ) : (
            <div className="ring-border mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm ring-1">
              <img
                src="/brand/taamul-mark.png"
                alt="Taamul Connect"
                width={36}
                height={36}
                className="h-9 w-9"
              />
            </div>
          )}
          <CardTitle className="text-foreground text-xl">
            {inviteToken ? t('titleAccept') : t('titleWelcome')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken ? t('descAccept') : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="border-destructive/30 bg-destructive-soft text-destructive rounded-lg border px-4 py-3 text-sm">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20 dark:bg-input/30 h-10"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-primary hover:text-primary/80 text-sm"
                >
                  {t('forgotPassword')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20 dark:bg-input/30 h-10"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="bg-primary text-primary-foreground hover:bg-primary-hover mt-2 h-10 w-full disabled:opacity-50"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          {/* No "create account" link: this CRM has no self-service
              signup. An admin provisions every login from
              Settings -> Members, which is also where their role is
              set. Someone with no account has nobody to sign up as,
              so pointing them at a form would be a dead end. */}
          <p className="text-muted-foreground mt-6 text-center text-sm">
            {t('noAccountAskAdmin')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
