# syntax=docker/dockerfile:1

# Node 22, not 20: @supabase/supabase-js (2.108) builds its Realtime
# client inside createClient and throws on a Node without a global
# WebSocket, so on node:20 every server-side Supabase client failed at
# runtime. Keep in step with .github/workflows/ci.yml.

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they must be provided as build args (docker-compose.yml
# forwards them from .env.local). Server-only secrets (service role
# key, ENCRYPTION_KEY, ...) are read at runtime and
# must NOT be baked into the image.
# ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
# Optional browser softphone (docs/yeastar.md); empty = desk phones only.
ARG NEXT_PUBLIC_LINKUS_SDK_URL=
ARG NEXT_PUBLIC_PBX_ORIGIN=
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_PUBLIC_LINKUS_SDK_URL=$NEXT_PUBLIC_LINKUS_SDK_URL \
    NEXT_PUBLIC_PBX_ORIGIN=$NEXT_PUBLIC_PBX_ORIGIN \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
# ---------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000
# Liveness only (GET /api/healthz never touches the database), so a slow
# database doesn't get the container restarted; readiness is /api/readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
