-- ============================================================
-- 128_case_takeover.sql — the take-over log: a supervisor taking over a
-- customer conversation of a case. Port of module 018c
-- (018c_takeover.sql), over 122's cases and case_role.
--
--  * A supervisor (the coordinator of the case, or the team lead of the
--    case agent's team) takes over: the caller records the attempt here,
--    then sends the hand-over message through the normal send path. One
--    row per attempt, no idempotency. The row is written BEFORE the send
--    and stays when the send is then blocked or refused: it records the
--    intent.
--  * TABLE case_takeover_log: append-only (UPDATE / DELETE / TRUNCATE
--    refused by trigger, the owner included); RLS forced with no policy;
--    no privilege for any API role, service_role included.
--  * case_takeover_record(p_actor, p_case, p_template_version) -> bigint
--    (the log id): allowed only when case_role(case, actor) is
--    'coordinator' or 'team_lead' (both may write the case). Agent,
--    admin and super_admin are refused, as anyone with no role.
--    Refusals (hint): CASE_NOT_FOUND, NOT_ALLOWED, TEMPLATE_INVALID
--    (template version NULL, whitespace-only or over 40 characters).
--    taken_at is the server clock.
--
-- The SECURITY DEFINER function reads RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '128 must be applied by a superuser or BYPASSRLS role (case_takeover_record reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Table ----------

CREATE TABLE IF NOT EXISTS public.case_takeover_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id          uuid NOT NULL,
  account_id       uuid NOT NULL,
  actor            uuid NOT NULL,
  template_version text NOT NULL,
  taken_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_takeover_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_takeover_log_version_check CHECK (template_version !~ '^[[:space:]]*$'
    AND char_length(template_version) <= 40)
);
CREATE INDEX IF NOT EXISTS case_takeover_log_case_idx ON public.case_takeover_log (case_id, id);
COMMENT ON TABLE public.case_takeover_log IS
  'One row per take-over attempt. Written only through case_takeover_record; read by no API role. Append-only. Migration 128.';

ALTER TABLE public.case_takeover_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_takeover_log FORCE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS case_takeover_log_append_only ON public.case_takeover_log;
CREATE TRIGGER case_takeover_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_takeover_log FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_takeover_log_no_truncate ON public.case_takeover_log;
CREATE TRIGGER case_takeover_log_no_truncate
  BEFORE TRUNCATE ON public.case_takeover_log FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 2. Record ----------

CREATE OR REPLACE FUNCTION public.case_takeover_record(p_actor uuid, p_case uuid, p_template_version text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
  v_id   bigint;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT (coalesce(v_role IN ('coordinator', 'team_lead'), false) AND public.case_rule_can_write(v_role)) THEN
    RAISE EXCEPTION 'case %: % may not take over', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_template_version IS NULL OR p_template_version ~ '^[[:space:]]*$' OR char_length(p_template_version) > 40 THEN
    RAISE EXCEPTION 'template version must be 1..40 characters, not blank'
      USING ERRCODE = 'check_violation', HINT = 'TEMPLATE_INVALID';
  END IF;
  INSERT INTO public.case_takeover_log (case_id, account_id, actor, template_version)
  VALUES (c.id, c.account_id, p_actor, p_template_version)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 3. Privileges ----------

REVOKE ALL ON public.case_takeover_log FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_takeover_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.case_takeover_record(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_takeover_record(uuid, uuid, text) TO service_role;

RESET lock_timeout;
