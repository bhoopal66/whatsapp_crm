-- ============================================================
-- 258_web_form_http_origins.sql — a form's allowed websites may be
-- http:// as well as https://.
--
-- 249 accepted https origins only. A customer's site that is still on
-- http, or a local test page (http://localhost:3000), could therefore
-- neither post to the form nor frame it. An admin lists a site on
-- purpose, so the list now takes http://host[:port] too: scheme,
-- lower-case host, optional port, nothing else (no path, query or
-- credentials, as before). The TS twin is normalizeAllowedOrigin
-- (src/lib/web-form/origin.ts): change both.
--
-- Restates 249's web_form_origin_ok and web_form_set (only the check
-- and the wording of its refusal change). Re-running 249 after this puts
-- the https-only rule back: apply in order, once.
-- Asserted by supabase/ci/verify-web-lead-form.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '258 must be applied by a superuser or BYPASSRLS role (web_form_set reads an RLS-forced table)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.web_form_origin_ok(p_origin text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_origin IS NOT NULL
     AND char_length(p_origin) <= 200
     AND p_origin ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$';
$$;

REVOKE ALL ON FUNCTION public.web_form_origin_ok(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.web_form_origin_ok(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.web_form_set(
  p_enabled boolean, p_allowed_origins text[], p_rotate boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  v_origins text[];
  v_bad text;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can change the web form'
      USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'The switch is required'
      USING ERRCODE = '22023', HINT = 'bad_settings';
  END IF;
  SELECT coalesce(array_agg(DISTINCT o ORDER BY o), '{}')
    INTO v_origins
    FROM unnest(coalesce(p_allowed_origins, '{}')) AS o;
  IF cardinality(v_origins) > 20 THEN
    RAISE EXCEPTION 'At most 20 allowed origins'
      USING ERRCODE = '22023', HINT = 'too_many_origins';
  END IF;
  SELECT o INTO v_bad FROM unnest(v_origins) AS o
   WHERE NOT public.web_form_origin_ok(o) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Not an http(s) origin: %', left(v_bad, 80)
      USING ERRCODE = '22023', HINT = 'bad_origin';
  END IF;

  INSERT INTO public.web_lead_forms AS w
         (account_id, token, enabled, allowed_origins)
  VALUES (v_acct, public.web_form_new_token(), p_enabled, v_origins)
  ON CONFLICT (account_id) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         allowed_origins = EXCLUDED.allowed_origins,
         token = CASE WHEN coalesce(p_rotate, false)
                      THEN EXCLUDED.token ELSE w.token END,
         updated_at = now();

  RETURN public.web_form_get();
END;
$$;

REVOKE ALL ON FUNCTION public.web_form_set(boolean, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.web_form_set(boolean, text[], boolean) TO authenticated;
