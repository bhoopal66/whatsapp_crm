-- 084_edge_security.sql
--
-- Edge security stores (module 017a): the Meta webhook's replay keys,
-- the sliding-window rate limiter and the admin login lockout.
--
-- Why Postgres and why RPCs: every app instance must share one window
-- and one clock, or a second instance doubles every limit and a skewed
-- server clock opens a lockout early. The app reaches Postgres only
-- through supabase-js, so each store operation is one function here
-- (lib/edge/*-store) instead of raw SQL in the app. The functions use
-- the database clock; `p_now` exists only so tests can replay fixed
-- times (`useCallerClock`).
--
-- * Replay is two-phase. A claim takes a 60 s lease on a message key;
--   the host confirms it only after the event is persisted, which turns
--   it into a 24 h seen-key. A claim that is never confirmed (a crash)
--   lapses, so Meta's retry is processed instead of being dropped as a
--   duplicate. A claim is one upsert that takes over a row whose
--   confirmation or lease has run out, so concurrent claims have one
--   winner and correctness never depends on edge_purge.
-- * The rate check serialises on (scope, key) with an advisory xact
--   lock, prunes the window, counts, and records the hit only when
--   allowed (a refused caller is not locked out forever).
-- * The lockout is a sliding log: 5 failures for one (ip, user) or 20
--   from one ip within 10 minutes lock the pair / the whole ip for 15.
--   A success nulls only that pair's user_key, so those failures still
--   count toward the ip's 20. Failures serialise per ip.
--
-- Server-side only: RLS on with no policies, nothing granted to anon or
-- authenticated, service_role gets table DML and EXECUTE. Re-runnable.

CREATE TABLE IF NOT EXISTS public.edge_seen_keys (
  key         TEXT PRIMARY KEY,
  claim_token TEXT,
  lease_until TIMESTAMPTZ,
  confirmed   BOOLEAN NOT NULL DEFAULT true,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_seen_keys_expires_idx
  ON public.edge_seen_keys (expires_at);

CREATE TABLE IF NOT EXISTS public.edge_rate_events (
  scope TEXT        NOT NULL,
  key   TEXT        NOT NULL,
  at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_rate_events_scope_key_at_idx
  ON public.edge_rate_events (scope, key, at);
CREATE INDEX IF NOT EXISTS edge_rate_events_at_idx
  ON public.edge_rate_events (at);

-- user_key: the user id tried ('' when none); NULL once a success
-- cleared it (it still counts for the ip).
CREATE TABLE IF NOT EXISTS public.edge_auth_failures (
  ip       TEXT        NOT NULL,
  user_key TEXT,
  at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_auth_failures_ip_at_idx
  ON public.edge_auth_failures (ip, at);

-- user_key NULL = the whole ip is locked.
CREATE TABLE IF NOT EXISTS public.edge_auth_locks (
  ip           TEXT        NOT NULL,
  user_key     TEXT,
  locked_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT edge_auth_locks_ip_user_key UNIQUE NULLS NOT DISTINCT (ip, user_key)
);

ALTER TABLE public.edge_seen_keys     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_rate_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_auth_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_auth_locks    ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Rate limit: one sliding-log check. Returns the hint the caller needs
-- for Retry-After: when the oldest hit leaves the window.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edge_rate_check(
  p_scope TEXT, p_key TEXT, p_limit INTEGER, p_window_ms INTEGER,
  p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, retry_after_ms INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_now    TIMESTAMPTZ := coalesce(p_now, clock_timestamp());
  v_start  TIMESTAMPTZ := v_now - make_interval(secs => p_window_ms / 1000.0);
  v_count  INTEGER;
  v_oldest TIMESTAMPTZ;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_scope), pg_catalog.hashtext(p_key));
  DELETE FROM public.edge_rate_events e
   WHERE e.scope = p_scope AND e.key = p_key AND e.at <= v_start;
  SELECT count(*)::integer, min(e.at) INTO v_count, v_oldest
    FROM public.edge_rate_events e
   WHERE e.scope = p_scope AND e.key = p_key;
  IF v_count >= p_limit THEN
    RETURN QUERY SELECT false, 0,
      greatest(1, ceil(extract(epoch FROM (v_oldest - v_start)) * 1000))::integer;
    RETURN;
  END IF;
  INSERT INTO public.edge_rate_events (scope, key, at) VALUES (p_scope, p_key, v_now);
  RETURN QUERY SELECT true, p_limit - v_count - 1, 0;
END
$$;

-- ---------------------------------------------------------------------
-- Replay: claim → 'new' | 'inflight' | 'done'. A row is free once its
-- confirmation (confirmed) or its lease (unconfirmed) has run out; the
-- upsert takes it over, and its row count says who won. A loser that
-- cannot see a live confirmation answers 'inflight' (Meta retries).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edge_replay_claim(
  p_key TEXT, p_token TEXT, p_lease_seconds INTEGER,
  p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_now   TIMESTAMPTZ := coalesce(p_now, clock_timestamp());
  v_lease TIMESTAMPTZ := v_now + make_interval(secs => p_lease_seconds);
  v_won   INTEGER;
  v_done  BOOLEAN;
BEGIN
  INSERT INTO public.edge_seen_keys AS s
         (key, claim_token, lease_until, confirmed, expires_at)
  VALUES (p_key, p_token, v_lease, false, v_lease)
  ON CONFLICT (key) DO UPDATE
     SET claim_token = excluded.claim_token, lease_until = excluded.lease_until,
         confirmed = false, expires_at = excluded.expires_at
   WHERE CASE WHEN s.confirmed THEN s.expires_at
              ELSE coalesce(s.lease_until, s.expires_at) END <= v_now;
  GET DIAGNOSTICS v_won = ROW_COUNT;
  IF v_won = 1 THEN
    RETURN 'new';
  END IF;
  SELECT k.confirmed AND k.expires_at > v_now INTO v_done
    FROM public.edge_seen_keys k WHERE k.key = p_key;
  RETURN CASE WHEN coalesce(v_done, false) THEN 'done' ELSE 'inflight' END;
END
$$;

-- Marks the key done for p_ttl_seconds, only when p_token is the
-- current claim. True when confirmed.
CREATE OR REPLACE FUNCTION public.edge_replay_confirm(
  p_key TEXT, p_token TEXT, p_ttl_seconds INTEGER,
  p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.edge_seen_keys s
     SET confirmed = true,
         expires_at = coalesce(p_now, clock_timestamp())
                      + make_interval(secs => p_ttl_seconds),
         lease_until = NULL, claim_token = NULL
   WHERE s.key = p_key AND s.claim_token = p_token;
  RETURN FOUND;
END
$$;

-- Drops the key only when p_token is the current, still-unconfirmed
-- claim, so the message can be claimed again at once.
CREATE OR REPLACE FUNCTION public.edge_replay_release(p_key TEXT, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.edge_seen_keys s
   WHERE s.key = p_key AND s.claim_token = p_token AND NOT s.confirmed;
  RETURN FOUND;
END
$$;

-- ---------------------------------------------------------------------
-- Lockout: log one failed login and lock the pair / the whole ip when
-- its sliding count reaches the limit. Returns the lock state of
-- (ip, user_key) afterwards.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edge_auth_fail(
  p_ip TEXT, p_user_key TEXT, p_now TIMESTAMPTZ DEFAULT NULL,
  p_ip_max INTEGER DEFAULT 20, p_user_max INTEGER DEFAULT 5,
  p_window_ms INTEGER DEFAULT 600000, p_lock_ms INTEGER DEFAULT 900000)
RETURNS TABLE (locked BOOLEAN, retry_after_ms INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_now   TIMESTAMPTZ := coalesce(p_now, clock_timestamp());
  v_until TIMESTAMPTZ := v_now + make_interval(secs => p_lock_ms / 1000.0);
  v_ip    INTEGER;
  v_pair  INTEGER;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('edge_auth'), pg_catalog.hashtext(p_ip));
  DELETE FROM public.edge_auth_failures f
   WHERE f.ip = p_ip AND f.at <= v_now - make_interval(secs => p_window_ms / 1000.0);
  INSERT INTO public.edge_auth_failures (ip, user_key, at) VALUES (p_ip, p_user_key, v_now);
  SELECT count(*)::integer, (count(*) FILTER (WHERE f.user_key = p_user_key))::integer
    INTO v_ip, v_pair
    FROM public.edge_auth_failures f WHERE f.ip = p_ip;
  IF v_pair >= p_user_max THEN
    INSERT INTO public.edge_auth_locks AS l (ip, user_key, locked_until)
    VALUES (p_ip, p_user_key, v_until)
    ON CONFLICT (ip, user_key) DO UPDATE
       SET locked_until = greatest(l.locked_until, excluded.locked_until);
  END IF;
  IF v_ip >= p_ip_max THEN
    INSERT INTO public.edge_auth_locks AS l (ip, user_key, locked_until)
    VALUES (p_ip, NULL, v_until)
    ON CONFLICT (ip, user_key) DO UPDATE
       SET locked_until = greatest(l.locked_until, excluded.locked_until);
  END IF;
  RETURN QUERY
    SELECT max(l.locked_until) IS NOT NULL,
           coalesce(ceil(extract(epoch FROM (max(l.locked_until) - v_now)) * 1000), 0)::integer
      FROM public.edge_auth_locks l
     WHERE l.ip = p_ip AND (l.user_key = p_user_key OR l.user_key IS NULL)
       AND l.locked_until > v_now;
END
$$;

-- A success forgets (ip, user_key)'s failures for the per-user count
-- only; they still count toward the ip's limit.
CREATE OR REPLACE FUNCTION public.edge_auth_success(p_ip TEXT, p_user_key TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.edge_auth_failures f SET user_key = NULL
   WHERE f.ip = p_ip AND f.user_key = p_user_key;
$$;

-- Locked if (ip, user_key) or the whole ip is locked.
CREATE OR REPLACE FUNCTION public.edge_auth_lock_state(
  p_ip TEXT, p_user_key TEXT, p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (locked BOOLEAN, retry_after_ms INTEGER)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH t AS (SELECT coalesce(p_now, clock_timestamp()) AS ts)
  SELECT max(l.locked_until) IS NOT NULL,
         coalesce(ceil(extract(epoch FROM (max(l.locked_until) - t.ts)) * 1000), 0)::integer
    FROM t LEFT JOIN public.edge_auth_locks l
      ON l.ip = p_ip AND (l.user_key = p_user_key OR l.user_key IS NULL)
     AND l.locked_until > t.ts
   GROUP BY t.ts;
$$;

-- Housekeeping for keys that went idle; schedule it (pg_cron, every
-- 15 minutes: SELECT public.edge_purge()). Nothing depends on it for
-- correctness — expired rows are taken over or ignored.
CREATE OR REPLACE FUNCTION public.edge_purge(
  p_now TIMESTAMPTZ DEFAULT now(),
  p_rate_horizon INTERVAL DEFAULT interval '1 hour')
RETURNS TABLE (seen_keys INTEGER, rate_events INTEGER, auth_failures INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE a INTEGER; b INTEGER; c INTEGER; d INTEGER;
BEGIN
  -- Confirmed keys go when their TTL ends; unconfirmed claims when
  -- their lease lapses.
  DELETE FROM public.edge_seen_keys s
   WHERE CASE WHEN s.confirmed THEN s.expires_at
              ELSE coalesce(s.lease_until, s.expires_at) END <= p_now;
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM public.edge_rate_events e WHERE e.at <= p_now - p_rate_horizon;
  GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM public.edge_auth_failures f WHERE f.at <= p_now - interval '1 hour';
  GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM public.edge_auth_locks l WHERE l.locked_until <= p_now;
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN QUERY SELECT a, b, c + d;
END
$$;

-- ---------------------------------------------------------------------
-- Privileges: revoke Supabase's default grants, give service_role the
-- minimum the stores use.
-- ---------------------------------------------------------------------
REVOKE ALL ON public.edge_seen_keys, public.edge_rate_events,
  public.edge_auth_failures, public.edge_auth_locks
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.edge_rate_check(TEXT, TEXT, INTEGER, INTEGER, TIMESTAMPTZ),
  public.edge_replay_claim(TEXT, TEXT, INTEGER, TIMESTAMPTZ),
  public.edge_replay_confirm(TEXT, TEXT, INTEGER, TIMESTAMPTZ),
  public.edge_replay_release(TEXT, TEXT),
  public.edge_auth_fail(TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER),
  public.edge_auth_success(TEXT, TEXT),
  public.edge_auth_lock_state(TEXT, TEXT, TIMESTAMPTZ),
  public.edge_purge(TIMESTAMPTZ, INTERVAL)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.edge_seen_keys,
  public.edge_rate_events, public.edge_auth_failures, public.edge_auth_locks
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.edge_rate_check(TEXT, TEXT, INTEGER, INTEGER, TIMESTAMPTZ),
  public.edge_replay_claim(TEXT, TEXT, INTEGER, TIMESTAMPTZ),
  public.edge_replay_confirm(TEXT, TEXT, INTEGER, TIMESTAMPTZ),
  public.edge_replay_release(TEXT, TEXT),
  public.edge_auth_fail(TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER),
  public.edge_auth_success(TEXT, TEXT),
  public.edge_auth_lock_state(TEXT, TEXT, TIMESTAMPTZ),
  public.edge_purge(TIMESTAMPTZ, INTERVAL)
  TO service_role;
