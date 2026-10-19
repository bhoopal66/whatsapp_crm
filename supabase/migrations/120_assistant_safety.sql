-- ============================================================
-- 120_assistant_safety.sql — assistant tool-call guard: human
-- confirmation bound to the exact action, an atomic fail-closed rate
-- limiter, and an append-only audit of every transition and decision
--
-- Server-side state for the assistant guard (src/assist in the
-- reference module). Port of module 019a.
--
--  * assist_pending_actions: one row per risky action awaiting a HUMAN
--    confirmation. action_hash = sha256 of the canonical JSON of
--    {tool, args}; the nonce is stored as sha256 only. Rows are created
--    only by assist_pending_request, which fixes HERE what the caller
--    may not choose: the nonce (20 hex chars of gen_random_uuid(),
--    returned once), the lifetime (expires_at = now() + 300 s) and the
--    cap (at most 5 OPEN rows per user: pending and unexpired, across
--    accounts; a per-user advisory lock serialises count-then-insert).
--    Status moves forward only (trigger assist_pending_guard):
--      pending -> confirmed | expired | denied ; confirmed -> consumed | expired.
--    Identity (who, where, what, nonce, expiry) never changes; rows are
--    never deleted (DELETE and TRUNCATE refused). Every insert and
--    transition is copied into assist_audit (kind 'pending') by a
--    trigger. service_role reads the table and changes a status only
--    through assist_pending_confirm / _consume / _expire / _cancel.
--  * assist_rate_events: one row per ALLOWED attempt, key
--    'namespace:subject' (the app uses assistant:user:<uuid> and
--    assistant:workspace:<account uuid>). assist_rate_take takes one
--    slot on every key or on none (advisory lock per key in sorted
--    order, count after the lock, insert only if all are under limit);
--    a refused attempt stores nothing and returns retry_after_ms. Rows
--    leave only through assist_rate_prune (older than two of their own
--    windows) and the per-key, audited assist_rate_reset, which is NOT
--    granted to service_role (an owner / admin connection runs it).
--  * assist_audit: append-only (UPDATE / DELETE / TRUNCATE refused by
--    trigger, owner included).
--
-- wacrm mapping: workspace_id text -> account_id uuid (FK accounts;
-- nullable on assist_audit, whose rate_reset rows name no account);
-- user ids are auth user ids (uuid, no FK: audit rows outlive people);
-- actor stays a text label (assistant:<uuid>, human:<uuid>@<channel>,
-- system:assist). The reference's owner-only RLS policies are dropped:
-- RLS is forced with NO policy, the function owner (superuser /
-- BYPASSRLS) and service_role (BYPASSRLS) pass, anon / authenticated
-- have no privilege at all.
--
-- The one structural change from 019a: the reference consumed a
-- confirmed action and appended its decision audit row in one
-- client-side transaction. wacrm reaches Postgres only through
-- PostgREST, one statement per call, so assist_pending_consume now
-- takes the decision row's fields (run_id, tool, detail) and, ONLY
-- when it moved the row confirmed -> consumed, inserts the kind
-- 'decision' audit row (outcome 'ALLOW:CONFIRMED') in the same call.
-- If that insert fails the function raises with HINT
-- 'AUDIT_UNAVAILABLE' and the whole call rolls back: the row stays
-- 'confirmed' and a retry executes it exactly once. A consume that
-- moves nothing inserts nothing and returns false (the app classifies
-- the refusal and audits the DENY itself).
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 115
-- and 121, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '120 must be applied by a superuser or BYPASSRLS role (the assist_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.assist_pending_actions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid        NOT NULL REFERENCES public.accounts(id),
  user_id       uuid        NOT NULL,
  run_id        text,
  tool          text        NOT NULL,
  args          jsonb       NOT NULL,
  action_hash   text        NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash    text        NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'confirmed', 'expired', 'denied', 'consumed')),
  actor         text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  confirmed_at  timestamptz,
  closed_at     timestamptz,
  CONSTRAINT assist_pending_actions_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 day')
);
CREATE INDEX IF NOT EXISTS assist_pending_actions_open_idx
  ON public.assist_pending_actions (expires_at) WHERE status IN ('pending', 'confirmed');
CREATE INDEX IF NOT EXISTS assist_pending_actions_user_open_idx
  ON public.assist_pending_actions (user_id, expires_at) WHERE status = 'pending';

-- key = 'namespace:subject'; a subject may hold a uuid (assistant:user:<uuid>).
CREATE TABLE IF NOT EXISTS public.assist_rate_events (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*:.+$'),
  ts        timestamptz NOT NULL DEFAULT clock_timestamp(),
  window_ms bigint      NOT NULL CHECK (window_ms > 0)
);
CREATE INDEX IF NOT EXISTS assist_rate_events_key_ts_idx ON public.assist_rate_events (key, ts);

CREATE TABLE IF NOT EXISTS public.assist_audit (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind         text        NOT NULL CHECK (kind IN ('pending', 'confirm_refused', 'consume_refused', 'decision',
                                                    'execution', 'rate_reset')),
  actor        text        NOT NULL,
  account_id   uuid        REFERENCES public.accounts(id),
  user_id      uuid,
  run_id       text,
  tool         text,
  pending_id   uuid,
  action_hash  text,
  outcome      text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS assist_audit_pending_idx ON public.assist_audit (pending_id) WHERE pending_id IS NOT NULL;

-- No policies: FORCE binds the owner too, so only a superuser /
-- BYPASSRLS role (the function owner, service_role) passes.
ALTER TABLE public.assist_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assist_rate_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assist_audit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assist_pending_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.assist_rate_events     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.assist_audit           FORCE ROW LEVEL SECURITY;

-- ---------- 2. Guards (owner included) ----------

-- Pending actions: insert as pending only; forward-only status; fixed identity; never deleted.
CREATE OR REPLACE FUNCTION public.assist_pending_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.confirmed_at is not null or new.closed_at is not null then
      raise exception 'public.assist_pending_actions: a pending action is inserted pending (INSERT refused)'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if (new.id, new.account_id, new.user_id, new.run_id, new.tool, new.args, new.action_hash, new.nonce_hash,
        new.created_at, new.expires_at)
       is distinct from
       (old.id, old.account_id, old.user_id, old.run_id, old.tool, old.args, old.action_hash, old.nonce_hash,
        old.created_at, old.expires_at) then
      raise exception 'public.assist_pending_actions: the action identity is fixed (UPDATE refused)'
        using errcode = 'insufficient_privilege';
    end if;
    if not ((old.status = 'pending'   and new.status in ('confirmed', 'expired', 'denied'))
         or (old.status = 'confirmed' and new.status in ('consumed', 'expired'))) then
      raise exception 'public.assist_pending_actions: % -> % refused (pending -> confirmed|expired|denied, confirmed -> consumed|expired)',
        old.status, new.status
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  raise exception 'public.assist_pending_actions: % refused (rows are never removed)', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

-- Every insert and transition of a pending action is appended to the audit.
CREATE OR REPLACE FUNCTION public.assist_pending_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  insert into public.assist_audit (kind, actor, account_id, user_id, run_id, tool, pending_id, action_hash, outcome, detail)
  values ('pending', new.actor, new.account_id, new.user_id, new.run_id, new.tool, new.id, new.action_hash, new.status,
          case when tg_op = 'UPDATE' then jsonb_build_object('from', old.status) else '{}'::jsonb end);
  return null;
end
$$;

CREATE OR REPLACE FUNCTION public.assist_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
begin
  raise exception 'public.% is append-only (% refused)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end
$$;

DROP TRIGGER IF EXISTS assist_pending_guard ON public.assist_pending_actions;
CREATE TRIGGER assist_pending_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.assist_pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.assist_pending_guard();
DROP TRIGGER IF EXISTS assist_pending_audit ON public.assist_pending_actions;
CREATE TRIGGER assist_pending_audit
  AFTER INSERT OR UPDATE ON public.assist_pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.assist_pending_audit();
DROP TRIGGER IF EXISTS assist_pending_no_truncate ON public.assist_pending_actions;
CREATE TRIGGER assist_pending_no_truncate
  BEFORE TRUNCATE ON public.assist_pending_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.assist_append_only();
DROP TRIGGER IF EXISTS assist_audit_append_only ON public.assist_audit;
CREATE TRIGGER assist_audit_append_only
  BEFORE UPDATE OR DELETE ON public.assist_audit
  FOR EACH ROW EXECUTE FUNCTION public.assist_append_only();
DROP TRIGGER IF EXISTS assist_audit_no_truncate ON public.assist_audit;
CREATE TRIGGER assist_audit_no_truncate
  BEFORE TRUNCATE ON public.assist_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.assist_append_only();
DROP TRIGGER IF EXISTS assist_rate_events_no_truncate ON public.assist_rate_events;
CREATE TRIGGER assist_rate_events_no_truncate
  BEFORE TRUNCATE ON public.assist_rate_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.assist_append_only();

-- ---------- 3. Rate limiter ----------

-- One call takes one slot on EVERY key or on none: the keys are locked in sorted order
-- (pg_advisory_xact_lock(hashtext(key)), held to the end of the caller's transaction — one PostgREST call), each
-- key's window is counted AFTER its lock is held (plpgsql takes a fresh snapshot per statement, so a slot committed by
-- the previous lock holder is seen), and the rows are inserted only if every key is under its limit. A refused attempt
-- inserts nothing. Returns the first refusing key and how long until its oldest event in the window leaves it.
-- SECURITY INVOKER, as in 019a: service_role holds SELECT / INSERT on assist_rate_events.
DROP FUNCTION IF EXISTS public.assist_rate_take(text[], integer[], bigint[]);
CREATE FUNCTION public.assist_rate_take(p_keys text[], p_limits integer[], p_windows_ms bigint[])
RETURNS TABLE (allowed boolean, denied_key text, retry_after_ms bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
declare
  v_i      integer;
  v_n      integer;
  v_count  bigint;
  v_oldest timestamptz;
  v_order  integer[];
begin
  -- The count below relies on a fresh snapshot after the lock (READ COMMITTED); a REPEATABLE READ / SERIALIZABLE
  -- caller's snapshot predates the lock and would miss the previous holder's slot.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'assist_rate_take: requires READ COMMITTED (advisory locks do not serialise under a snapshot taken before the lock)'
      using errcode = 'invalid_transaction_state';
  end if;
  v_n := coalesce(array_length(p_keys, 1), 0);
  if v_n = 0 or v_n <> coalesce(array_length(p_limits, 1), 0) or v_n <> coalesce(array_length(p_windows_ms, 1), 0) then
    raise exception 'assist_rate_take: keys, limits and windows must be non-empty and the same length'
      using errcode = 'invalid_parameter_value';
  end if;
  select array_agg(i order by p_keys[i]) into v_order from generate_subscripts(p_keys, 1) as i;
  foreach v_i in array v_order loop
    perform pg_advisory_xact_lock(hashtext(p_keys[v_i]));
  end loop;
  foreach v_i in array v_order loop
    select count(*), min(e.ts) into v_count, v_oldest
      from public.assist_rate_events e
     where e.key = p_keys[v_i]
       and e.ts > clock_timestamp() - p_windows_ms[v_i] * interval '1 millisecond';
    if v_count >= p_limits[v_i] then
      return query select false, p_keys[v_i],
        greatest(1, ceil(extract(epoch from (v_oldest + p_windows_ms[v_i] * interval '1 millisecond' - clock_timestamp())) * 1000))::bigint;
      return;
    end if;
  end loop;
  insert into public.assist_rate_events (key, window_ms)
  select p_keys[i], p_windows_ms[i] from generate_subscripts(p_keys, 1) as i;
  return query select true, null::text, 0::bigint;
end
$$;

-- Removes only rows older than two of their own windows: never an event that can still count.
CREATE OR REPLACE FUNCTION public.assist_rate_prune()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_n bigint;
begin
  delete from public.assist_rate_events where ts < clock_timestamp() - 2 * window_ms * interval '1 millisecond';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Per-key admin reset, always audited. There is deliberately no all-keys variant. Not granted to service_role.
CREATE OR REPLACE FUNCTION public.assist_rate_reset(p_key text, p_actor text, p_reason text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_n bigint;
begin
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]*:.+$' then
    raise exception 'assist_rate_reset: a namespaced key is required' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_actor), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'assist_rate_reset: actor and reason are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_key));
  delete from public.assist_rate_events where key = p_key;
  get diagnostics v_n = row_count;
  insert into public.assist_audit (kind, actor, outcome, detail)
  values ('rate_reset', p_actor, 'RESET', jsonb_build_object('key', p_key, 'reason', p_reason, 'removed', v_n));
  return v_n;
end
$$;

-- ---------- 4. Pending actions ----------

-- Request: the only insert path (service_role has no INSERT). The cap (5 OPEN pending actions per user: status
-- 'pending', not yet expired, across accounts), the TTL (300 s) and the nonce are fixed HERE, not by the caller, so a
-- service_role session cannot mint a row with a nonce it chose or a lifetime it chose. A per-user transaction advisory
-- lock serialises count-then-insert, so two racing requests cannot both take the last slot. The nonce is 20 hex chars
-- of gen_random_uuid() (core, no pgcrypto); only its sha256 is stored (the same hash assist_pending_confirm compares).
-- Returns one row (id, nonce) with the plain nonce, once; no row when the user is at the cap.
DROP FUNCTION IF EXISTS public.assist_pending_request(uuid, uuid, text, text, jsonb, text, text);
CREATE FUNCTION public.assist_pending_request(p_account uuid, p_user uuid, p_run text, p_tool text,
                                              p_args jsonb, p_action_hash text, p_actor text)
RETURNS TABLE (id uuid, nonce text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_nonce text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
begin
  perform pg_advisory_xact_lock(hashtextextended('assist_pending_request:' || p_user::text, 0));
  if (select count(*) from public.assist_pending_actions a
       where a.user_id = p_user and a.status = 'pending' and a.expires_at > now()) >= 5 then
    return;
  end if;
  return query
  insert into public.assist_pending_actions as a
    (account_id, user_id, run_id, tool, args, action_hash, nonce_hash, actor, expires_at)
  values (p_account, p_user, p_run, p_tool, p_args, p_action_hash,
          encode(sha256(convert_to(v_nonce, 'UTF8')), 'hex'), p_actor, now() + interval '300 seconds')
  returning a.id, v_nonce;
end
$$;

-- Confirm / consume / expire / cancel. service_role has NO UPDATE on assist_pending_actions: every status change goes
-- through one of these SECURITY DEFINER functions, each one atomic UPDATE ... WHERE <all checks> that returns whether
-- it moved the row. Confirm takes the RAW nonce and hashes it here, so reading nonce_hash does not help a caller: only
-- whoever holds the nonce (the human it was sent to) can confirm. The trigger above still enforces the transitions.
CREATE OR REPLACE FUNCTION public.assist_pending_confirm(p_id uuid, p_user uuid, p_account uuid, p_nonce text,
                                                         p_actor text, p_decision text DEFAULT 'confirmed')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_id uuid;
begin
  if p_decision is null or p_decision not in ('confirmed', 'denied') then
    raise exception 'assist_pending_confirm: decision must be confirmed or denied' using errcode = 'invalid_parameter_value';
  end if;
  update public.assist_pending_actions
     set status = p_decision, actor = p_actor,
         confirmed_at = case when p_decision = 'confirmed' then now() end,
         closed_at    = case when p_decision = 'denied' then now() end
   where id = p_id and user_id = p_user and account_id = p_account
     and nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex')
     and status = 'pending' and expires_at > now()
  returning id into v_id;
  return v_id is not null;
end
$$;

-- confirmed -> consumed AND its decision audit row, in this one call (the wacrm change, see the header). The decision
-- row carries what the app's insertDecision writes: kind 'decision', actor p_actor, the account / user, p_run_id,
-- p_tool, pending_id p_id, p_action_hash, outcome 'ALLOW:CONFIRMED', detail p_detail ({mode, risk}). If that insert
-- fails, RAISE with HINT 'AUDIT_UNAVAILABLE' (the original SQLSTATE in DETAIL): the statement fails, the UPDATE rolls
-- back with it and the row stays 'confirmed'. Returns false, inserting nothing, when no row moved.
DROP FUNCTION IF EXISTS public.assist_pending_consume(uuid, uuid, uuid, text, text, text, text, jsonb);
CREATE FUNCTION public.assist_pending_consume(p_id uuid, p_user uuid, p_account uuid, p_action_hash text,
                                              p_actor text, p_run_id text, p_tool text, p_detail jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_id    uuid;
  v_state text;
  v_msg   text;
begin
  update public.assist_pending_actions
     set status = 'consumed', actor = p_actor, closed_at = now()
   where id = p_id and user_id = p_user and account_id = p_account and action_hash = p_action_hash
     and status = 'confirmed' and expires_at > now()
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  begin
    insert into public.assist_audit (kind, actor, account_id, user_id, run_id, tool, pending_id, action_hash, outcome, detail)
    values ('decision', p_actor, p_account, p_user, p_run_id, p_tool, p_id, p_action_hash, 'ALLOW:CONFIRMED',
            coalesce(p_detail, '{}'::jsonb));
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    raise exception 'assist_pending_consume: the decision audit append failed; nothing was consumed'
      using detail = v_state || ': ' || v_msg, hint = 'AUDIT_UNAVAILABLE';
  end;
  return true;
end
$$;

-- pending|confirmed past expires_at -> expired: one row (p_id) or all of them (p_id null, the sweep). Returns how many.
CREATE OR REPLACE FUNCTION public.assist_pending_expire(p_actor text, p_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v_n bigint;
begin
  update public.assist_pending_actions
     set status = 'expired', actor = p_actor, closed_at = now()
   where (p_id is null or id = p_id) and status in ('pending', 'confirmed') and expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- pending -> denied by the system, for a row the human can never act on: notifying the human failed, or the decision
-- audit of its NEEDS_CONFIRMATION failed (the app's cancelPending). Frees the per-user cap slot instead of leaving it
-- to expire. The transition and its decision audit row ('DENY:' || p_reason, actor 'system:assist') are written in
-- this one call. Acts only on a row still 'pending'; any other status (or an unknown id) is a no-op that returns false.
CREATE OR REPLACE FUNCTION public.assist_pending_cancel(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v public.assist_pending_actions%rowtype;
begin
  if p_reason is null or p_reason !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'assist_pending_cancel: reason must be an UPPER_SNAKE code' using errcode = 'invalid_parameter_value';
  end if;
  update public.assist_pending_actions
     set status = 'denied', actor = 'system:assist', closed_at = now()
   where id = p_id and status = 'pending'
  returning * into v;
  if not found then
    return false;
  end if;
  insert into public.assist_audit (kind, actor, account_id, user_id, run_id, tool, pending_id, action_hash, outcome)
  values ('decision', 'system:assist', v.account_id, v.user_id, v.run_id, v.tool, v.id, v.action_hash, 'DENY:' || p_reason);
  return true;
end
$$;

-- ---------- 5. Privileges ----------

-- Start from nothing (a new table, sequence and function grant anon,
-- authenticated and service_role everything by default), then grant
-- service_role exactly what the app uses.
REVOKE ALL ON public.assist_pending_actions, public.assist_rate_events, public.assist_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.assist_rate_events_id_seq, public.assist_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.assist_pending_guard(),
  public.assist_pending_audit(),
  public.assist_append_only(),
  public.assist_rate_take(text[], integer[], bigint[]),
  public.assist_rate_prune(),
  public.assist_rate_reset(text, text, text),
  public.assist_pending_request(uuid, uuid, text, text, jsonb, text, text),
  public.assist_pending_confirm(uuid, uuid, uuid, text, text, text),
  public.assist_pending_consume(uuid, uuid, uuid, text, text, text, text, jsonb),
  public.assist_pending_expire(text, uuid),
  public.assist_pending_cancel(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- No INSERT / UPDATE on assist_pending_actions: rows are created only
-- through assist_pending_request (the per-user cap) and status changes
-- only through the definer functions.
GRANT SELECT ON public.assist_pending_actions TO service_role;
GRANT SELECT, INSERT ON public.assist_rate_events, public.assist_audit TO service_role;

-- assist_rate_reset is NOT granted: a per-key reset is an admin action,
-- run on an owner / admin connection.
GRANT EXECUTE ON FUNCTION
  public.assist_rate_take(text[], integer[], bigint[]),
  public.assist_rate_prune(),
  public.assist_pending_request(uuid, uuid, text, text, jsonb, text, text),
  public.assist_pending_confirm(uuid, uuid, uuid, text, text, text),
  public.assist_pending_consume(uuid, uuid, uuid, text, text, text, text, jsonb),
  public.assist_pending_expire(text, uuid),
  public.assist_pending_cancel(uuid, text)
  TO service_role;
