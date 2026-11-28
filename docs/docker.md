# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).
   It listens on **127.0.0.1 only**: put your reverse proxy or tunnel
   on the same host. Docker's published ports go around ufw, so a port
   on every interface let anyone skip the proxy (plain http, and a
   forged client-IP header past the sign-in lockout). When the proxy is
   on another machine, set `HOST_BIND=0.0.0.0` and firewall the port to
   that machine only.

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. That includes
  the optional browser softphone's `NEXT_PUBLIC_LINKUS_SDK_URL` and
  `NEXT_PUBLIC_PBX_ORIGIN` (`docs/yeastar.md`); with plain Docker add
  them as `--build-arg`s too.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `ENCRYPTION_KEY`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t taamul-connect .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 taamul-connect
```

## Notes

- **Disable public signup in Supabase Auth.** This CRM has no signup
  screen — admins provision logins from Settings → Workspace → Members, through the
  service role — but GoTrue's own `POST /auth/v1/signup` is open by
  default and reachable with the public anon key that ships in the
  browser bundle. Left open, anyone can mint a session (as owner of a
  fresh, empty account). On a self-hosted Supabase set, in its `.env`:

  ```
  DISABLE_SIGNUP=true
  ENABLE_PHONE_SIGNUP=false
  ENABLE_PHONE_AUTOCONFIRM=false
  ENABLE_ANONYMOUS_USERS=false
  ```

  and recreate the auth container (`docker compose up -d auth`). Keep
  `ENABLE_EMAIL_SIGNUP=true` — despite the name it is what enables
  email/password *login*. On Supabase Cloud, turn off "Allow new users
  to sign up" under Authentication → Providers. Check with
  `curl <supabase-url>/auth/v1/settings -H "apikey: <anon key>"`:
  `disable_signup` must be `true`.
- **Deactivating a member** (Settings → Workspace → Members, migration 069)
  bans their login through the GoTrue admin API, so it needs
  `SUPABASE_SERVICE_ROLE_KEY` like creating one does. A ban refuses
  sign-in and token refresh but cannot revoke an access token already
  issued; RLS stops honouring it immediately, and it expires on its
  own after `JWT_EXPIRY` (1 hour by default). Since migration 199 it
  also takes them off their team and unlinks their Yeastar extension;
  reactivating restores neither.
- Database migrations under `supabase/` are **not** run by the
  container. Apply a range with
  `DATABASE_URL=... scripts/apply-migrations.sh FROM TO` (or the
  "Apply migrations" GitHub Action): a superuser or BYPASSRLS role over
  a session connection (not a transaction pooler), a `pg_dump` backup
  first unless `SKIP_BACKUP=1`, each file in its own `psql` call, one
  run at a time per database (advisory lock). From migration 338 each
  applied file is recorded in `public.migration_ledger` with its
  sha256; a file edited after it was applied stops the run before
  anything is applied unless `ALLOW_DRIFT=1`, and
  `scripts/apply-migrations.sh --status FROM TO` lists each file as
  applied / changed / not recorded without applying anything. Files
  applied before 338 show as "not recorded" until they are next applied
  by the script.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Whapi deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp → Connections →
  Attachment Storage; attachments received while it's off become
  unviewable once the gateway drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- If a **reverse proxy** fronts a self-hosted Supabase (so the browser
  reaches the app and Supabase on one origin), raise its
  response-header buffer. PostgREST echoes the whole request filter
  back in the `Content-Location` response header, so a bulk lookup —
  `?phone_normalized=in.(...)` with a few hundred values, as a CSV
  broadcast import does — answers 200 straight from Kong and 502
  through the proxy, logged as nginx's `upstream sent too big header`.
  supabase-js surfaces the proxy's HTML error page as the query's error
  message, so the symptom is a wall of markup where a reason should be.
  For nginx, in the location that proxies Supabase:

  ```nginx
  proxy_buffer_size       32k;
  proxy_buffers        8  32k;
  proxy_busy_buffers_size 64k;
  ```

  The same buffers are needed on the location that proxies the app: a
  signed-in request triggers the middleware's session refresh, which
  writes the rotated auth token back as chunked `Set-Cookie` headers
  well past the 4 KB default.

- Nothing inside the container is scheduled. If you use automation
  Wait steps, flows, or scheduled broadcasts, point an external
  scheduler at `GET /api/automations/cron`, `GET /api/flows/cron` and
  `GET /api/whatsapp/broadcast/cron` on this deployment, sending the
  shared secret in the `x-cron-secret` header (`AUTOMATION_CRON_SECRET`,
  see `.env.local.example`). All of them return 503 until that variable
  is set. A minute is a sensible interval; the broadcast cron starts at
  most five due campaigns per call and defers any that fall inside
  their quiet hours. The automation cron also runs the WhatsApp number
  health check at most every five minutes (`GET
  /api/whatsapp/health/cron` runs it on its own, if you prefer a
  separate schedule): it marks a logged-out Whapi number disconnected
  and notifies owners and admins.
