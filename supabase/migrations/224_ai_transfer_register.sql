-- ============================================================
-- 224_ai_transfer_register.sql — PDPL cross-border transfer to AI
-- providers: the legal basis on record per workspace, and a register of
-- every call that carries customer text abroad. Port of package 033k,
-- widened from its case reviewer to every AI path here (the reply bot,
-- drafts, translation, HR AI drafts, embeddings of customer text, and
-- Jev / TypeSafe).
--
--  * ai_transfer_basis (one row per workspace): basis (consent |
--    contract | adequacy | scc | other), a note of 20+ characters, who
--    approved it, the providers' region, and require_basis. Written by
--    owners / admins (ai_transfer_basis_set).
--  * require_basis is OFF by default (the owner's decision): AI works as
--    today and every call is logged. Switched on, every AI call of the
--    workspace is refused until a complete basis (all four fields) is on
--    record.
--  * ai_transfer_check(account, destination, purpose, model, bytes) —
--    service role, called by the app just before each call: appends one
--    ai_transfer_log row (sizes and labels only: no text, no ids) and
--    answers whether the call may go. Log-before-send: when the basis is
--    required and the row cannot be written, the call does not go.
--  * ai_transfer_log is append-only for every role.
--
-- SECURITY DEFINER, service role only; tables force RLS with no grants.
-- Apply after 223 as a superuser or BYPASSRLS role. Re-runnable.
-- verify-privacy.sql; docs/privacy.md.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '224 must be applied by a superuser or BYPASSRLS role';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_transfer_basis (
  account_id      uuid PRIMARY KEY REFERENCES public.accounts(id),
  basis           text NULL,
  basis_note      text NULL,
  approved_by     text NULL,
  provider_region text NULL,
  require_basis   boolean NOT NULL DEFAULT false,
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_transfer_basis_basis_check
    CHECK (basis IS NULL OR basis IN ('consent', 'contract', 'adequacy', 'scc', 'other')),
  CONSTRAINT ai_transfer_basis_note_check
    CHECK (basis_note IS NULL OR (char_length(btrim(basis_note)) BETWEEN 20 AND 2000)),
  CONSTRAINT ai_transfer_basis_text_check
    CHECK ((approved_by IS NULL OR char_length(approved_by) BETWEEN 1 AND 200)
           AND (provider_region IS NULL OR char_length(provider_region) BETWEEN 1 AND 100))
);
COMMENT ON TABLE public.ai_transfer_basis IS
  'A workspace''s recorded legal basis for sending customer text to AI providers abroad, and whether it is required. Migration 224.';

CREATE TABLE IF NOT EXISTS public.ai_transfer_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES public.accounts(id),
  at               timestamptz NOT NULL DEFAULT now(),
  destination      text NOT NULL,
  purpose          text NOT NULL,
  model            text NULL,
  input_bytes      integer NOT NULL,
  basis            text NULL,
  provider_region  text NULL,
  allowed          boolean NOT NULL,
  CONSTRAINT ai_transfer_log_destination_check CHECK (destination IN ('openai', 'anthropic', 'typesafe')),
  CONSTRAINT ai_transfer_log_purpose_check CHECK (purpose ~ '^[a-z_]{1,40}$'),
  CONSTRAINT ai_transfer_log_model_check CHECK (model IS NULL OR char_length(model) <= 100),
  CONSTRAINT ai_transfer_log_bytes_check CHECK (input_bytes >= 0)
);
CREATE INDEX IF NOT EXISTS ai_transfer_log_account_idx ON public.ai_transfer_log (account_id, at DESC);
COMMENT ON TABLE public.ai_transfer_log IS
  'Append-only register of AI calls carrying customer text abroad: destination, purpose, model, size, basis; no text, no ids. Migration 224.';

DROP TRIGGER IF EXISTS ai_transfer_log_no_update ON public.ai_transfer_log;
CREATE TRIGGER ai_transfer_log_no_update BEFORE UPDATE ON public.ai_transfer_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS ai_transfer_log_no_delete ON public.ai_transfer_log;
CREATE TRIGGER ai_transfer_log_no_delete BEFORE DELETE ON public.ai_transfer_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS ai_transfer_log_no_truncate ON public.ai_transfer_log;
CREATE TRIGGER ai_transfer_log_no_truncate BEFORE TRUNCATE ON public.ai_transfer_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

ALTER TABLE public.ai_transfer_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_transfer_basis FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_transfer_basis FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.ai_transfer_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_transfer_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_transfer_log FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ai_transfer_basis_get(p_actor uuid, p_account uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.privacy_require_admin('ai_transfer_basis_get', p_actor, p_account);
  RETURN jsonb_build_object(
    'basis', (SELECT jsonb_build_object('basis', b.basis, 'note', b.basis_note, 'approved_by', b.approved_by,
                       'provider_region', b.provider_region, 'require_basis', b.require_basis, 'recorded_at', b.recorded_at)
                FROM public.ai_transfer_basis b WHERE b.account_id = p_account),
    'last_30_days', (SELECT coalesce(jsonb_object_agg(d, n), '{}'::jsonb) FROM (
                       SELECT l.destination || ':' || l.purpose AS d, count(*) AS n FROM public.ai_transfer_log l
                        WHERE l.account_id = p_account AND l.at > now() - interval '30 days'
                        GROUP BY 1) x),
    'refused_30_days', (SELECT count(*) FROM public.ai_transfer_log l
                         WHERE l.account_id = p_account AND l.at > now() - interval '30 days' AND NOT l.allowed));
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_transfer_basis_set(p_actor uuid, p_account uuid, p_basis text, p_note text,
  p_approved_by text, p_region text, p_require boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note text := CASE WHEN p_note ~ '^[[:space:]]*$' THEN NULL ELSE btrim(p_note) END;
  v_by   text := CASE WHEN p_approved_by ~ '^[[:space:]]*$' THEN NULL ELSE btrim(p_approved_by) END;
  v_reg  text := CASE WHEN p_region ~ '^[[:space:]]*$' THEN NULL ELSE btrim(p_region) END;
BEGIN
  PERFORM public.privacy_require_admin('ai_transfer_basis_set', p_actor, p_account);
  IF p_require IS NULL OR (p_basis IS NOT NULL AND p_basis NOT IN ('consent', 'contract', 'adequacy', 'scc', 'other'))
     OR (v_note IS NOT NULL AND char_length(v_note) NOT BETWEEN 20 AND 2000)
     OR char_length(v_by) > 200 OR char_length(v_reg) > 100 THEN
    RAISE EXCEPTION 'ai_transfer_basis_set: basis is consent | contract | adequacy | scc | other, the note 20-2000 characters'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.ai_transfer_basis (account_id, basis, basis_note, approved_by, provider_region, require_basis,
                                        recorded_by, recorded_at)
  VALUES (p_account, p_basis, v_note, v_by, v_reg, p_require, p_actor, now())
  ON CONFLICT (account_id) DO UPDATE
    SET basis = excluded.basis, basis_note = excluded.basis_note, approved_by = excluded.approved_by,
        provider_region = excluded.provider_region, require_basis = excluded.require_basis,
        recorded_by = excluded.recorded_by, recorded_at = now();
  RETURN public.ai_transfer_basis_get(p_actor, p_account);
END;
$$;

-- Just before an AI call: log it and say whether it may go.
CREATE OR REPLACE FUNCTION public.ai_transfer_check(p_account uuid, p_destination text, p_purpose text,
  p_model text, p_bytes integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  b         public.ai_transfer_basis%ROWTYPE;
  v_allowed boolean;
BEGIN
  SELECT * INTO b FROM public.ai_transfer_basis x WHERE x.account_id = p_account;
  v_allowed := NOT coalesce(b.require_basis, false)
               OR (b.basis IS NOT NULL AND b.basis_note IS NOT NULL AND b.approved_by IS NOT NULL
                   AND b.provider_region IS NOT NULL);
  INSERT INTO public.ai_transfer_log (account_id, destination, purpose, model, input_bytes, basis, provider_region, allowed)
  VALUES (p_account, p_destination, p_purpose, left(p_model, 100), greatest(coalesce(p_bytes, 0), 0),
          b.basis, b.provider_region, v_allowed);
  RETURN v_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_transfer_basis_get(uuid, uuid),
  public.ai_transfer_basis_set(uuid, uuid, text, text, text, text, boolean),
  public.ai_transfer_check(uuid, text, text, text, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_transfer_basis_get(uuid, uuid),
  public.ai_transfer_basis_set(uuid, uuid, text, text, text, text, boolean),
  public.ai_transfer_check(uuid, text, text, text, integer)
TO service_role;
