-- ============================================================
-- 232_desk_bank_cover.sql — primary and second coordinator per bank,
-- leave, and queue-age alerts that someone acts on (design 035 revision
-- A, slice D).
--
--  * A bank has 1-2 coordinators (133's holders, coordinator_banks). One
--    may be named PRIMARY and one SECOND (desk_bank_roles); the row needs
--    the person to hold that bank (FK to coordinator_banks, so losing the
--    bank drops the role). Owners and admins set them.
--  * Leave: desk_leave(user, first day, last day) in Asia/Dubai days.
--    The person themselves, team leaders and up set it; it changes no
--    access (a coordinator on leave still holds their bank).
--  * Cover (desk_bank_cover): the primary if live and not on leave, else
--    the second if live and not on leave, else the team lead ('lead': the
--    desk duty owner of 230 if live staff, else the workspace owner).
--  * Alerts replace load caps: the sorting queue's oldest waiting upload
--    of a bank (220) past 2 hours alerts the second coordinator (else
--    whoever covers), past 4 hours the lead, once per upload and level.
--    desk_queue_alerts_due lists them; the automations cron raises each
--    as a follow-up task through 085's system writer (source_ref
--    'desk_queue:<item>:<level>' dedupes). The no-bank queue alerts the
--    lead at 2 hours.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role after 231. Re-runnable. Asserted by
-- supabase/ci/verify-desk-bank-cover.sql. docs/case-desk.md is the
-- contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '232 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_settings') IS NULL THEN
    RAISE EXCEPTION '232: apply 230_desk_whatsapp_routing.sql first';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.desk_bank_roles (
  account_id  uuid NOT NULL,
  bank_code   text NOT NULL,
  role        text NOT NULL,
  user_id     uuid NOT NULL,
  set_by      uuid NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, bank_code, role),
  CONSTRAINT desk_bank_roles_role_check CHECK (role IN ('primary', 'second')),
  CONSTRAINT desk_bank_roles_one_role_each UNIQUE (account_id, bank_code, user_id),
  CONSTRAINT desk_bank_roles_holder_fkey FOREIGN KEY (account_id, user_id, bank_code)
    REFERENCES public.coordinator_banks (account_id, user_id, bank_code) ON DELETE CASCADE
);
ALTER TABLE public.desk_bank_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_bank_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_bank_roles FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_bank_roles IS
  'A bank''s primary and second coordinator (each a holder of the bank, 133). Migration 232.';

CREATE TABLE IF NOT EXISTS public.desk_leave (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  first_day   date NOT NULL,
  last_day    date NOT NULL,
  note        text NULL,
  set_by      uuid NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_leave_days_check CHECK (last_day >= first_day AND last_day - first_day <= 366),
  CONSTRAINT desk_leave_note_check CHECK (note IS NULL OR char_length(note) <= 200)
);
CREATE INDEX IF NOT EXISTS desk_leave_user_idx ON public.desk_leave (account_id, user_id, last_day);
ALTER TABLE public.desk_leave ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_leave FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_leave FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_leave IS
  'Staff leave for desk cover (Asia/Dubai days, inclusive). Changes no access. Migration 232.';

-- ---------- 2. Who covers ----------

CREATE OR REPLACE FUNCTION public.desk_today(p_now timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT (coalesce(p_now, now()) AT TIME ZONE 'Asia/Dubai')::date $$;

CREATE OR REPLACE FUNCTION public.desk_on_leave(p_account uuid, p_user uuid, p_day date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.desk_leave l
                  WHERE l.account_id = p_account AND l.user_id = p_user
                    AND p_day BETWEEN l.first_day AND l.last_day)
$$;

-- Live, holding the bank, not on leave that day.
CREATE OR REPLACE FUNCTION public.desk_available(p_account uuid, p_user uuid, p_bank text, p_day date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user IS NOT NULL AND public.case_holds_bank(p_account, p_user, p_bank)
     AND NOT public.desk_on_leave(p_account, p_user, p_day)
$$;

-- The lead: the desk duty owner (230) if live staff, else the workspace's
-- longest-standing live owner.
CREATE OR REPLACE FUNCTION public.desk_lead_for(p_account uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT s.duty_user_id FROM public.desk_settings s
      WHERE s.account_id = p_account AND public.case_account_role(p_account, s.duty_user_id) IS NOT NULL),
    (SELECT p.user_id FROM public.profiles p
      WHERE p.account_id = p_account AND p.account_role = 'owner' AND p.deactivated_at IS NULL
      ORDER BY p.created_at, p.user_id LIMIT 1))
$$;

-- Who covers a bank on a day: (user, level) with level primary | second | lead.
CREATE OR REPLACE FUNCTION public.desk_bank_cover(p_account uuid, p_bank text, p_day date)
RETURNS TABLE (user_id uuid, level text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH r AS (
    SELECT (SELECT x.user_id FROM public.desk_bank_roles x
             WHERE x.account_id = p_account AND x.bank_code = p_bank AND x.role = 'primary') AS pri,
           (SELECT x.user_id FROM public.desk_bank_roles x
             WHERE x.account_id = p_account AND x.bank_code = p_bank AND x.role = 'second') AS sec
  )
  SELECT CASE WHEN public.desk_available(p_account, r.pri, p_bank, p_day) THEN r.pri
              WHEN public.desk_available(p_account, r.sec, p_bank, p_day) THEN r.sec
              ELSE public.desk_lead_for(p_account) END,
         CASE WHEN public.desk_available(p_account, r.pri, p_bank, p_day) THEN 'primary'
              WHEN public.desk_available(p_account, r.sec, p_bank, p_day) THEN 'second'
              ELSE 'lead' END
    FROM r
$$;

-- ---------- 3. Setting roles and leave ----------

-- Owner / admin: name a bank's primary or second (NULL clears it). The
-- person must hold the bank; one person holds one role per bank.
CREATE OR REPLACE FUNCTION public.desk_bank_role_set(p_actor uuid, p_account uuid, p_bank text, p_role text,
  p_user uuid, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_bank_role_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('primary', 'second')
     OR NOT EXISTS (SELECT 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank)
     OR (p_user IS NOT NULL AND NOT public.case_holds_bank(p_account, p_user, p_bank)) THEN
    PERFORM public.desk_refuse('desk_bank_role_set', 'INVALID', 'a bank of this workspace and one of its live holders');
  END IF;
  DELETE FROM public.desk_bank_roles x
   WHERE x.account_id = p_account AND x.bank_code = p_bank
     AND (x.role = p_role OR (p_user IS NOT NULL AND x.user_id = p_user));
  IF p_user IS NOT NULL THEN
    INSERT INTO public.desk_bank_roles (account_id, bank_code, role, user_id, set_by, set_at)
    VALUES (p_account, p_bank, p_role, p_user, p_actor, coalesce(p_now, now()));
  END IF;
END;
$$;

-- Leave for oneself, or for anyone by a team leader and up.
CREATE OR REPLACE FUNCTION public.desk_leave_add(p_actor uuid, p_account uuid, p_user uuid, p_first date,
  p_last date, p_note text, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL
     OR (p_user IS DISTINCT FROM p_actor
         AND coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE) THEN
    PERFORM public.desk_refuse('desk_leave_add', 'NOT_ALLOWED', 'your own leave, or team leaders and up');
  END IF;
  IF p_user IS NULL OR public.case_account_role(p_account, p_user) IS NULL
     OR p_first IS NULL OR p_last IS NULL OR p_last < p_first OR p_last - p_first > 366
     OR p_last < public.desk_today(p_now)
     OR (p_note IS NOT NULL AND char_length(p_note) > 200) THEN
    PERFORM public.desk_refuse('desk_leave_add', 'INVALID', 'live staff and a range of up to a year, not in the past');
  END IF;
  INSERT INTO public.desk_leave (account_id, user_id, first_day, last_day, note, set_by, set_at)
  VALUES (p_account, p_user, p_first, p_last, public.desk_clean(p_note), p_actor, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_leave_remove(p_actor uuid, p_account uuid, p_leave uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  l public.desk_leave%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.desk_leave x WHERE x.id = p_leave AND x.account_id = p_account;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF public.case_account_role(p_account, p_actor) IS NULL
     OR (l.user_id IS DISTINCT FROM p_actor
         AND coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE) THEN
    PERFORM public.desk_refuse('desk_leave_remove', 'NOT_ALLOWED', 'your own leave, or team leaders and up');
  END IF;
  DELETE FROM public.desk_leave x WHERE x.id = p_leave;
  RETURN true;
END;
$$;

-- ---------- 4. Reading ----------

-- Team leader and up: per bank with holders, the roles, today's cover and
-- the holders with any current or future leave.
CREATE OR REPLACE FUNCTION public.desk_cover_list(p_actor uuid, p_account uuid, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (bank_code text, bank_name text, primary_user uuid, second_user uuid, cover_user uuid,
               cover_level text, holders jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_day date := public.desk_today(p_now);
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_cover_list', 'NOT_ALLOWED', 'team leaders and up only');
  END IF;
  RETURN QUERY
  SELECT b.code, b.name,
         (SELECT x.user_id FROM public.desk_bank_roles x WHERE x.account_id = p_account AND x.bank_code = b.code AND x.role = 'primary'),
         (SELECT x.user_id FROM public.desk_bank_roles x WHERE x.account_id = p_account AND x.bank_code = b.code AND x.role = 'second'),
         cv.user_id, cv.level,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'user_id', h.user_id, 'name', p.full_name,
                   'on_leave', public.desk_on_leave(p_account, h.user_id, v_day),
                   'leave', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'first_day', l.first_day,
                                                                          'last_day', l.last_day, 'note', l.note)
                                                       ORDER BY l.first_day), '[]'::jsonb)
                               FROM public.desk_leave l
                              WHERE l.account_id = p_account AND l.user_id = h.user_id AND l.last_day >= v_day))
                 ORDER BY p.full_name), '[]'::jsonb)
            FROM public.coordinator_banks h
            JOIN public.profiles p ON p.user_id = h.user_id AND p.account_id = h.account_id
           WHERE h.account_id = p_account AND h.bank_code = b.code
             AND public.case_holds_bank(p_account, h.user_id, b.code))
    FROM public.case_banks b
    CROSS JOIN LATERAL public.desk_bank_cover(p_account, b.code, v_day) cv
   WHERE b.account_id = p_account
     AND EXISTS (SELECT 1 FROM public.coordinator_banks h WHERE h.account_id = p_account AND h.bank_code = b.code)
   ORDER BY b.code;
END;
$$;

-- ---------- 5. Queue-age alerts (the automations cron) ----------

-- Per workspace and bank queue (NULL = the no-bank queue): the oldest
-- waiting upload, when past 2 h ('second') or 4 h ('lead'), with whom to
-- tell. The cron dedupes on (item, level) through the task's source_ref.
CREATE OR REPLACE FUNCTION public.desk_queue_alerts_due(p_now timestamptz DEFAULT NULL)
RETURNS TABLE (account_id uuid, bank_code text, level text, item_id uuid, age_minutes integer,
               waiting integer, assignee uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH q AS (
    SELECT DISTINCT ON (i.account_id, i.queue_bank_code)
           i.account_id AS acct, i.queue_bank_code AS bank, i.id AS item, i.received_at AS at,
           count(*) OVER (PARTITION BY i.account_id, i.queue_bank_code)::integer AS n
      FROM public.intake_items i
     WHERE i.state = 'untagged'
     ORDER BY i.account_id, i.queue_bank_code, i.received_at, i.id
  ), lv AS (
    SELECT q.*, extract(epoch FROM coalesce(p_now, now()) - q.at) / 60 AS mins FROM q
  )
  SELECT lv.acct, lv.bank,
         CASE WHEN lv.mins >= 240 OR lv.bank IS NULL THEN 'lead' ELSE 'second' END,
         lv.item, lv.mins::integer, lv.n,
         CASE
           WHEN lv.mins >= 240 OR lv.bank IS NULL THEN public.desk_lead_for(lv.acct)
           ELSE coalesce(
             (SELECT x.user_id FROM public.desk_bank_roles x
               WHERE x.account_id = lv.acct AND x.bank_code = lv.bank AND x.role = 'second'
                 AND public.desk_available(lv.acct, x.user_id, lv.bank, public.desk_today(p_now))),
             (SELECT cv.user_id FROM public.desk_bank_cover(lv.acct, lv.bank, public.desk_today(p_now)) cv))
         END
    FROM lv
   WHERE lv.mins >= 120
$$;

-- ---------- 6. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_today(timestamptz), public.desk_on_leave(uuid, uuid, date),
  public.desk_available(uuid, uuid, text, date), public.desk_lead_for(uuid),
  public.desk_bank_cover(uuid, text, date),
  public.desk_bank_role_set(uuid, uuid, text, text, uuid, timestamptz),
  public.desk_leave_add(uuid, uuid, uuid, date, date, text, timestamptz),
  public.desk_leave_remove(uuid, uuid, uuid),
  public.desk_cover_list(uuid, uuid, timestamptz), public.desk_queue_alerts_due(timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_bank_role_set(uuid, uuid, text, text, uuid, timestamptz),
  public.desk_leave_add(uuid, uuid, uuid, date, date, text, timestamptz),
  public.desk_leave_remove(uuid, uuid, uuid),
  public.desk_cover_list(uuid, uuid, timestamptz), public.desk_queue_alerts_due(timestamptz)
TO service_role;
