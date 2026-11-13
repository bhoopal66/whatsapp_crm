-- ============================================================
-- 198 — a per-person "Review all calls" permission.
--
-- An owner or admin can let any staff member (owner, admin, team
-- leader, agent or viewer; never a bank guest) review every call of
-- the workspace. For calls, and only for calls, a reviewer is treated
-- like an admin:
--
--   * every call of the active workspace, calls with no person too
--     (calls_select, pbx_can_view_call), and every live call
--     (call_live_select);
--   * the full Call report: pbx_call_stats scope 'workspace', the
--     people breakdown and customer names; pbx_call_report with every
--     person;
--   * play AND download any playable recording (call_access_log_guard;
--     the playable rule itself is unchanged).
--
-- Unchanged on purpose: the call-access audit log (call_access_log
-- SELECT) and pbx_audit stay owner/admin; recording holds, retention,
-- PBX settings and mandatory outcomes stay where they were; the call
-- writes (pbx_set_disposition, pbx_link_call_contact) keep their own
-- "on the call or a team leader" rule; chat call cards keep 103's
-- customer-name rule (can_view_contact); pbx_visible_user_ids() and
-- pbx_visible_contact_ids() are unchanged (the policies test
-- pbx_sees_all_calls() first, so a reviewer never needs their sets).
--
--   1. profiles.may_review_all_calls (default false), a guarded column
--      written only by set_member_call_review().
--   2. pbx_call_reviewer(user, account) and pbx_sees_all_calls().
--   3. The call rules above, rank >= 4 replaced by pbx_sees_all_calls()
--      (or pbx_call_reviewer() where the writer is the service role).
--
-- Apply after 192, in order, once: this file redefines 192's
-- enforce_profile_privilege_columns(), 113's pbx_can_view_call and
-- policies, 089's call_access_log_guard(), 119's pbx_call_stats() and
-- 098's pbx_call_report(). Re-running any of those files after 198
-- drops the reviewer rule again (re-running 192 drops the guard on
-- may_review_all_calls), so re-apply 198 after it.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- ============================================================

-- ---------- 1. The flag ----------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS may_review_all_calls boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.may_review_all_calls IS
  'Review all calls: this person sees every call, live call, recording (play and download) and the full Call report of this workspace, like an admin, for calls only. Written only by set_member_call_review(). Migration 198.';

-- 192's body with may_review_all_calls among the guarded columns:
-- without it a person could grant themselves every call.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.may_connect_personal_whatsapp IS DISTINCT FROM OLD.may_connect_personal_whatsapp
       OR NEW.department IS DISTINCT FROM OLD.department
       OR NEW.may_review_all_calls IS DISTINCT FROM OLD.may_review_all_calls
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id, department, email and deactivation cannot be changed directly; use the account member/invitation RPCs (department through set_member_department; email changes go through sign-in settings)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- switch_account() checked the caller itself, and moving out of a
  -- workspace where they were deactivated is what it is for; so is
  -- redeem_invitation(), whose token is the authority. Those are the
  -- only places this flag is raised; clients cannot set it.
  IF COALESCE(current_setting('app.account_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- Definer: runs as the function owner, so the profile guard above
-- (current_user = 'authenticated') lets its write through, as it does
-- for set_member_personal_whatsapp (190) and set_member_department (192).
CREATE OR REPLACE FUNCTION public.set_member_call_review(p_user_id uuid, p_allowed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can let someone review all calls'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_allowed IS NULL THEN
    RAISE EXCEPTION 'A person and a choice are required' USING ERRCODE = '22023';
  END IF;

  -- One writer per person at a time (the row lock switch_account takes).
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_allowed AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.user_id = p_user_id
       AND p.account_id = v_acct
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('owner', 'admin', 'team_leader', 'agent', 'viewer')
  ) THEN
    RAISE EXCEPTION 'Only a live staff member can be allowed to review all calls'
      USING ERRCODE = '22023', HINT = 'not_eligible';
  END IF;

  UPDATE public.profiles p
     SET may_review_all_calls = p_allowed
   WHERE p.user_id = p_user_id AND p.account_id = v_acct
     AND p.may_review_all_calls IS DISTINCT FROM p_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_call_review(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_call_review(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_member_call_review(uuid, boolean) IS
  'Allow or forbid a person to review all calls in the caller''s active account (owner/admin only). Allowing needs a live owner/admin/team_leader/agent/viewer (22023 not_eligible); forbidding is always allowed. Migration 198.';

-- ---------- 2. Who reviews ----------

-- The service-role path (call_access_log_guard) has no auth.uid(), so
-- it names the person and the workspace. A signed-in caller is
-- answered only about their active workspace, never about another.
CREATE OR REPLACE FUNCTION public.pbx_call_reviewer(p_user uuid, p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user IS NOT NULL AND p_account IS NOT NULL
     AND (auth.uid() IS NULL OR p_account = current_account_id())
     AND EXISTS (
       SELECT 1 FROM profiles p
        WHERE p.user_id = p_user
          AND p.account_id = p_account
          AND p.deactivated_at IS NULL
          AND p.account_role::text <> 'bank_guest'
          AND p.may_review_all_calls)
$$;
COMMENT ON FUNCTION public.pbx_call_reviewer(uuid, uuid) IS
  'True when the person has a live, non-guest profile in the workspace with may_review_all_calls. A signed-in caller is answered only about their active workspace. Migration 198.';

CREATE OR REPLACE FUNCTION public.pbx_sees_all_calls()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR current_account_id() IS NULL THEN false
    ELSE COALESCE(current_role_rank(), 0) >= 4
         OR pbx_call_reviewer(auth.uid(), current_account_id())
  END
$$;
COMMENT ON FUNCTION public.pbx_sees_all_calls() IS
  'The caller sees every call of their active workspace: an owner or admin, or a call reviewer (may_review_all_calls). Migration 198.';

REVOKE ALL ON FUNCTION public.pbx_call_reviewer(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pbx_sees_all_calls() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_call_reviewer(uuid, uuid), public.pbx_sees_all_calls()
  TO authenticated, service_role;

-- ---------- 3. The call rules ----------

-- 113's body, owner/admin widened to pbx_sees_all_calls().
CREATE OR REPLACE FUNCTION public.pbx_can_view_call(p_call public.calls)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_call.account_id IS NULL OR p_call.account_id IS DISTINCT FROM current_account_id() THEN false
    WHEN pbx_sees_all_calls() THEN true
    -- On the call, or it rang them; for a team leader, the same for a
    -- person of a team they lead.
    WHEN COALESCE(p_call.user_id = ANY (s.ppl), false)
      OR COALESCE(p_call.peer_user_id = ANY (s.ppl), false)
      OR (jsonb_typeof(p_call.meta -> 'rang_user_ids') = 'array'
          AND p_call.meta -> 'rang_user_ids' ?| s.ppl::text[]) THEN true
    WHEN p_call.contact_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = p_call.contact_id
         AND can_view_contact(c.account_id, c.id, c.user_id))
    ELSE false
  END
  FROM (SELECT pbx_visible_user_ids() AS ppl) s
$$;
COMMENT ON FUNCTION public.pbx_can_view_call(public.calls) IS
  'One call: the caller''s active account, and owner/admin or a call reviewer (198), a party to the call or rung by it (meta.rang_user_ids), a team leader for the same of a person in a team they lead, or able to see its contact (can_view_contact). Guests: nothing. The calls_select policy is the same rule over sets. Migrations 089, 113, 198.';

-- The rang list is matched only when it is an array: on a JSON string
-- or object `?|` would match the string or a key.
DROP POLICY IF EXISTS calls_select ON public.calls;
CREATE POLICY calls_select ON public.calls
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT public.pbx_sees_all_calls())
         OR user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR peer_user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR (jsonb_typeof(meta -> 'rang_user_ids') = 'array'
             AND (meta -> 'rang_user_ids') ?| (SELECT public.pbx_visible_user_ids()::text[]))
         OR contact_id IN (SELECT public.pbx_visible_contact_ids()))
  );

DROP POLICY IF EXISTS call_live_select ON public.call_live;
CREATE POLICY call_live_select ON public.call_live
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT public.pbx_sees_all_calls())
         OR answered_by = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR ringing_user_ids && (SELECT public.pbx_visible_user_ids()))
  );

-- 089's C-8 body: a call reviewer passes the member check and the
-- download check like an admin. The routes write this log on the
-- service role, so the reviewer is looked up by the row's own person
-- and workspace, not by auth.uid().
CREATE OR REPLACE FUNCTION public.call_access_log_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rank     integer;
  v_reviewer boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT CASE p.account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
             ELSE 0
           END
      INTO v_rank
      FROM profiles p
     WHERE p.user_id = NEW.user_id
       AND p.account_id = NEW.account_id
       AND p.deactivated_at IS NULL;
    v_reviewer := pbx_call_reviewer(NEW.user_id, NEW.account_id);
    IF COALESCE(v_rank, 0) < 2 AND NOT v_reviewer THEN
      RAISE EXCEPTION 'Only an active member of the call''s workspace can open its recording'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.action = 'download' AND COALESCE(v_rank, 0) < 3 AND NOT v_reviewer THEN
      RAISE EXCEPTION 'Only a team leader or above can download a recording'
        USING ERRCODE = '42501';
    END IF;
    IF NOT pbx_recording_playable(NEW.call_id) THEN
      RAISE EXCEPTION 'This recording is not playable (held, erased or not fetched)'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- The cascade from a deleted call or account is the only removal.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM calls WHERE id = OLD.call_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'call_access_log is append-only' USING ERRCODE = '42501';
END;
$$;

-- 119's body: a call reviewer gets the owner/admin report (the whole
-- workspace, calls with no person included, the people breakdown and
-- customer names; scope 'workspace').
CREATE OR REPLACE FUNCTION public.pbx_call_stats(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text,
  p_user uuid DEFAULT NULL,
  p_prev_from timestamptz DEFAULT NULL,
  p_prev_to   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := current_account_id();
  v_rank    integer := coalesce(current_role_rank(), 0);
  -- Owner/admin, or a call reviewer (198): the whole workspace.
  v_all     boolean := pbx_sees_all_calls();
  -- The people whose calls count; NULL for the whole workspace.
  v_scope   uuid[];
  v_people  boolean;
  v_prev    timestamptz := coalesce(p_prev_from, p_from - (p_to - p_from));
  v_prev_to timestamptz := coalesce(p_prev_to, p_from);
  v_result  jsonb;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL OR v_rank < 1 THEN
    RAISE EXCEPTION 'Only members of a workspace can view call statistics'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The period must end after it starts and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;
  IF (p_prev_from IS NULL) <> (p_prev_to IS NULL) OR v_prev_to <= v_prev
     OR v_prev_to > p_from OR v_prev_to - v_prev > interval '100 days' THEN
    RAISE EXCEPTION 'The previous period must end by the start of this one, after it starts, and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;
  -- Asking Postgres to convert is the check: a pg_timezone_names lookup
  -- reads every zone file and cost ~55 ms of a ~250 ms call.
  IF p_tz IS NULL THEN
    RAISE EXCEPTION 'Unknown time zone: NULL' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM now() AT TIME ZONE p_tz;
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'Unknown time zone: %', p_tz USING ERRCODE = '22023';
  END;

  IF NOT v_all THEN
    v_scope := pbx_visible_user_ids();
  END IF;
  IF p_user IS NOT NULL THEN
    IF v_scope IS NOT NULL AND NOT (p_user = ANY (v_scope)) THEN
      RAISE EXCEPTION 'You can view only your own calls and those of the teams you lead'
        USING ERRCODE = '42501';
    END IF;
    v_scope := ARRAY[p_user];
  END IF;
  v_people := (v_rank >= 3 OR v_all) AND p_user IS NULL;

  WITH base AS MATERIALIZED (
    SELECT k.id,
           k.user_id AS who,
           k.direction AS dir,
           k.disposition AS disp,
           k.remote_number AS num,
           k.contact_id AS contact,
           k.started_at AS at,
           (k.started_at AT TIME ZONE p_tz) AS loc,
           k.started_at >= p_from AS cur,
           -- 098's answered and missed rules.
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)) AS ans,
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)
            OR (k.direction = 'outbound' AND k.talk_seconds > 0)) AS conn,
           (k.direction = 'inbound'
            AND k.status IN ('no_answer', 'busy', 'abandoned', 'voicemail')) AS miss,
           k.talk_seconds AS talk,
           k.ring_seconds AS ring
      FROM calls k
     WHERE k.account_id = v_account
       -- This period and the previous one, which need not touch it.
       AND ((k.started_at >= p_from AND k.started_at < p_to)
            OR (k.started_at >= v_prev AND k.started_at < v_prev_to))
       AND k.direction IN ('inbound', 'outbound')
       AND (v_scope IS NULL OR k.user_id = ANY (v_scope))
  ),
  people AS (
    SELECT DISTINCT x.u
      FROM (SELECT b.who AS u FROM base b WHERE b.cur AND b.who IS NOT NULL
            UNION
            SELECT e.user_id FROM pbx_extensions e
             WHERE e.account_id = v_account AND e.user_id IS NOT NULL) x
     WHERE v_people AND (v_scope IS NULL OR x.u = ANY (v_scope))
  ),
  -- Each call once in every row it counts in; a row with no calls is
  -- one all-NULL row, counted as zero.
  keyed AS (
    SELECT 'summary'::text AS kind, NULL::uuid AS u, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON b.cur
    UNION ALL
    SELECT 'previous', NULL, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON NOT b.cur
    UNION ALL
    SELECT 'person', p.u, b.*
      FROM people p LEFT JOIN base b ON b.cur AND b.who = p.u
    UNION ALL
    SELECT 'none', NULL, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON b.cur AND b.who IS NULL
     WHERE v_people AND v_scope IS NULL
  ),
  figures AS (
    SELECT k.kind, k.u, jsonb_build_object(
             'calls',                count(k.id),
             'inbound_total',        count(*) FILTER (WHERE k.dir = 'inbound'),
             'inbound_answered',     count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'outbound_total',       count(*) FILTER (WHERE k.dir = 'outbound'),
             'outbound_answered',    count(*) FILTER (WHERE k.dir = 'outbound' AND k.conn),
             'missed',               count(*) FILTER (WHERE k.miss),
             'answer_rate',          round(count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans)::numeric
                                           / nullif(count(*) FILTER (WHERE k.dir = 'inbound'), 0), 4),
             'talk_seconds_total',   coalesce(sum(k.talk) FILTER (WHERE k.ans), 0),
             'talk_calls',           count(k.talk) FILTER (WHERE k.ans),
             'avg_talk_seconds',     round(avg(k.talk) FILTER (WHERE k.ans)),
             'longest_talk_seconds', max(k.talk) FILTER (WHERE k.ans),
             'ring_seconds_total',   coalesce(sum(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans), 0),
             'ring_calls',           count(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'avg_ring_seconds',     round(avg(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans)),
             'max_ring_seconds',     max(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'unique_numbers',       count(DISTINCT k.num),
             'with_outcome',         count(k.disp)) AS f
      FROM keyed k
     GROUP BY k.kind, k.u
  )
  SELECT jsonb_build_object(
    'summary',  (SELECT f.f FROM figures f WHERE f.kind = 'summary'),
    'previous', (SELECT f.f FROM figures f WHERE f.kind = 'previous'),
    'by_day', (
      SELECT jsonb_agg(jsonb_build_object(
               'day',               to_char(d.day, 'YYYY-MM-DD'),
               'calls',             coalesce(g.calls, 0),
               'inbound_answered',  coalesce(g.inbound_answered, 0),
               'outbound',          coalesce(g.outbound, 0),
               'outbound_answered', coalesce(g.outbound_answered, 0),
               'missed',            coalesce(g.missed, 0),
               'talk_seconds',      coalesce(g.talk_seconds, 0)) ORDER BY d.day)
        FROM generate_series((p_from AT TIME ZONE p_tz)::date,
                             ((p_to - interval '1 microsecond') AT TIME ZONE p_tz)::date,
                             interval '1 day') d(day)
        LEFT JOIN (
          SELECT b.loc::date AS day,
                 count(*) AS calls,
                 count(*) FILTER (WHERE b.dir = 'inbound' AND b.ans) AS inbound_answered,
                 count(*) FILTER (WHERE b.dir = 'outbound') AS outbound,
                 count(*) FILTER (WHERE b.dir = 'outbound' AND b.conn) AS outbound_answered,
                 count(*) FILTER (WHERE b.miss) AS missed,
                 coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds
            FROM base b WHERE b.cur
           GROUP BY b.loc::date) g ON g.day = d.day::date),
    'by_hour', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'dow', h.dow, 'hour', h.hour, 'calls', h.calls, 'answered', h.answered,
               'missed', h.missed, 'talk_seconds', h.talk_seconds) ORDER BY h.dow, h.hour)
        FROM (SELECT extract(isodow FROM b.loc)::integer AS dow,
                     extract(hour FROM b.loc)::integer AS hour,
                     count(*) AS calls,
                     count(*) FILTER (WHERE b.conn) AS answered,
                     count(*) FILTER (WHERE b.miss) AS missed,
                     coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds
                FROM base b WHERE b.cur
               GROUP BY 1, 2) h), '[]'::jsonb),
    'talk_buckets', (
      SELECT jsonb_agg(jsonb_build_object(
               'key', t.key, 'min_seconds', t.lo, 'max_seconds', t.hi,
               'calls', (SELECT count(*) FROM base b
                          WHERE b.cur AND b.ans AND b.talk >= t.lo
                            AND (t.hi IS NULL OR b.talk < t.hi))) ORDER BY t.lo)
        FROM (VALUES ('under_30s', 0, 30), ('30s_2m', 30, 120), ('2m_5m', 120, 300),
                     ('5m_15m', 300, 900), ('15m_plus', 900, NULL::integer)) t(key, lo, hi)),
    'outcomes', (
      SELECT jsonb_build_object(
               'interested',     count(*) FILTER (WHERE b.disp = 'interested'),
               'docs_requested', count(*) FILTER (WHERE b.disp = 'docs_requested'),
               'call_back',      count(*) FILTER (WHERE b.disp = 'call_back'),
               'not_eligible',   count(*) FILTER (WHERE b.disp = 'not_eligible'),
               'wrong_number',   count(*) FILTER (WHERE b.disp = 'wrong_number'),
               'none',           count(*) FILTER (WHERE b.ans AND b.disp IS NULL))
        FROM base b WHERE b.cur),
    'people', CASE WHEN v_people THEN coalesce((
      SELECT jsonb_agg(
               jsonb_build_object('kind', f.kind, 'user_id', f.u,
                                  'full_name', pr.full_name, 'extension', ex.extension) || f.f
               ORDER BY (f.kind = 'none'), lower(pr.full_name) NULLS LAST, f.u)
        FROM figures f
        LEFT JOIN profiles pr ON pr.user_id = f.u AND pr.account_id = v_account
        LEFT JOIN pbx_extensions ex ON ex.user_id = f.u AND ex.account_id = v_account
       WHERE f.kind IN ('person', 'none')), '[]'::jsonb) END,
    'top_numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'contact_id', t.contact,
               'contact_name', CASE WHEN ct.id IS NOT NULL
                                     AND (v_all OR can_view_contact(ct.account_id, ct.id, ct.user_id))
                                    THEN ct.name END,
               'remote_number', t.num, 'calls', t.calls,
               'talk_seconds', t.talk_seconds, 'last_call_at', t.last_at)
               ORDER BY t.calls DESC, t.last_at DESC)
        FROM (SELECT b.contact,
                     (array_agg(b.num ORDER BY b.at DESC) FILTER (WHERE b.num IS NOT NULL))[1] AS num,
                     count(*) AS calls,
                     coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds,
                     max(b.at) AS last_at
                FROM base b
               WHERE b.cur AND (b.contact IS NOT NULL OR b.num IS NOT NULL)
               GROUP BY b.contact, CASE WHEN b.contact IS NULL THEN b.num END
               ORDER BY count(*) DESC, max(b.at) DESC
               LIMIT 10) t
        LEFT JOIN contacts ct ON ct.id = t.contact AND ct.account_id = v_account), '[]'::jsonb),
    'longest', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'started_at', l.at, 'direction', l.dir,
               'remote_number', l.num, 'contact_id', l.contact,
               'contact_name', CASE WHEN ct.id IS NOT NULL
                                     AND (v_all OR can_view_contact(ct.account_id, ct.id, ct.user_id))
                                    THEN ct.name END,
               'talk_seconds', l.talk, 'user_id', l.who, 'user_name', pr.full_name)
               ORDER BY l.talk DESC, l.at DESC)
        FROM (SELECT b.* FROM base b
               WHERE b.cur AND b.ans AND b.talk IS NOT NULL
               ORDER BY b.talk DESC, b.at DESC
               LIMIT 10) l
        LEFT JOIN contacts ct ON ct.id = l.contact AND ct.account_id = v_account
        LEFT JOIN profiles pr ON pr.user_id = l.who AND pr.account_id = v_account), '[]'::jsonb),
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'tz', p_tz,
                                'previous_from', v_prev, 'previous_to', v_prev_to),
    'scope', CASE WHEN p_user IS NOT NULL THEN 'person'
                  WHEN v_all THEN 'workspace'
                  WHEN v_rank = 3 THEN 'team'
                  ELSE 'self' END,
    'user_id', p_user)
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz) IS
  'The Call report page''s figures for [p_from, p_to), at most 100 days, days and hours in p_tz: summary and the previous period ([p_prev_from, p_prev_to), else the equally long period just before), by day, weekday x hour, talk buckets, outcomes, people (leader and up, and call reviewers), top numbers, longest calls. Owners/admins and call reviewers the workspace (calls with no person included), a team leader their teams plus themselves, everyone else their own calls; p_user narrows to one person in that scope (42501 outside it). 098''s attribution. Migrations 119, 198.';

REVOKE ALL ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  TO authenticated;

-- 098's body: a call reviewer (any staff rank) gets everyone's rows.
CREATE OR REPLACE FUNCTION public.pbx_call_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  row_kind          text,
  user_id           uuid,
  full_name         text,
  extension         text,
  inbound_answered  integer,
  outbound          integer,
  missed            integer,
  talk_seconds      bigint,
  talk_calls        integer,
  ring_seconds      bigint,
  ring_calls        integer,
  outcomes          jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := current_account_id();
  v_rank    integer := coalesce(current_role_rank(), 0);
  -- Owner/admin, or a call reviewer (198): everyone.
  v_all     boolean := pbx_sees_all_calls();
  -- A team leader's people; NULL for an owner or admin (everyone).
  v_team    uuid[];
BEGIN
  IF v_uid IS NULL OR v_account IS NULL OR (v_rank < 3 AND NOT v_all) THEN
    RAISE EXCEPTION 'Only team leaders, admins and owners can view the call report'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The period must end after it starts and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;

  IF v_rank = 3 AND NOT v_all THEN
    SELECT array_agg(DISTINCT x.u) INTO v_team
      FROM (SELECT tm.user_id AS u
              FROM teams t
              JOIN team_members tm ON tm.team_id = t.id
             WHERE t.account_id = v_account
               AND t.leader_user_id = v_uid
            UNION
            SELECT v_uid) x
     WHERE x.u IS NOT NULL;
  END IF;

  RETURN QUERY
  WITH c AS (
    SELECT k.user_id AS who,
           k.direction AS dir,
           k.disposition AS disp,
           -- answered_at is kept from the live frames even when the final
           -- status is no_answer / voicemail / busy (answered, then
           -- transferred to a leg nobody took), so it only counts for a
           -- call still in progress; else that call was answered AND missed.
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)) AS ans,
           (k.direction = 'inbound'
            AND k.status IN ('no_answer', 'busy', 'abandoned', 'voicemail')) AS miss,
           k.talk_seconds AS talk,
           k.ring_seconds AS ring
      FROM calls k
     WHERE k.account_id = v_account
       AND k.started_at >= p_from
       AND k.started_at < p_to
       AND k.direction IN ('inbound', 'outbound')
  ),
  people AS (
    SELECT DISTINCT x.u
      FROM (SELECT c.who AS u FROM c WHERE c.who IS NOT NULL
            UNION
            SELECT e.user_id FROM pbx_extensions e
             WHERE e.account_id = v_account AND e.user_id IS NOT NULL) x
     WHERE v_team IS NULL OR x.u = ANY (v_team)
  ),
  -- Each call once in every row it counts in. The 'none' and 'total'
  -- rows exist with no calls too (one all-NULL row, counted as zero).
  keyed AS (
    SELECT 'person'::text AS kind, p.u, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM people p LEFT JOIN c ON c.who = p.u
    UNION ALL
    SELECT 'none'::text, NULL::uuid, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM (SELECT 1) one LEFT JOIN c ON c.who IS NULL
    UNION ALL
    SELECT 'total'::text, NULL::uuid, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM (SELECT 1) one LEFT JOIN c ON true
  )
  SELECT k.kind,
         k.u,
         pr.full_name,
         ex.extension,
         (count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans))::integer,
         (count(*) FILTER (WHERE k.dir = 'outbound'))::integer,
         (count(*) FILTER (WHERE k.miss))::integer,
         (coalesce(sum(k.talk) FILTER (WHERE k.ans), 0))::bigint,
         (count(k.talk) FILTER (WHERE k.ans))::integer,
         (coalesce(sum(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans), 0))::bigint,
         (count(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans))::integer,
         jsonb_build_object(
           'interested',     count(*) FILTER (WHERE k.disp = 'interested'),
           'docs_requested', count(*) FILTER (WHERE k.disp = 'docs_requested'),
           'call_back',      count(*) FILTER (WHERE k.disp = 'call_back'),
           'not_eligible',   count(*) FILTER (WHERE k.disp = 'not_eligible'),
           'wrong_number',   count(*) FILTER (WHERE k.disp = 'wrong_number'),
           'none',           count(*) FILTER (WHERE k.ans AND k.disp IS NULL))
    FROM keyed k
    LEFT JOIN profiles pr ON pr.user_id = k.u AND pr.account_id = v_account
    LEFT JOIN pbx_extensions ex ON ex.user_id = k.u AND ex.account_id = v_account
   GROUP BY k.kind, k.u, pr.full_name, ex.extension
   ORDER BY (k.kind = 'total'), (k.kind = 'none'), lower(pr.full_name) NULLS LAST, k.u;
END;
$$;

COMMENT ON FUNCTION public.pbx_call_report(timestamptz, timestamptz) IS
  'The Calls screen''s By person report for [p_from, p_to), at most 100 days: a row per person (owners/admins and call reviewers everyone, a team leader their teams plus themselves), one for calls with no person, and the workspace total. A missed ring-group call has no person and is counted once. Internal calls are left out. Migrations 098, 198.';

REVOKE ALL ON FUNCTION public.pbx_call_report(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_call_report(timestamptz, timestamptz)
  TO authenticated;
