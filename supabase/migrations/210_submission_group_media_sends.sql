-- ============================================================
-- 210: staff send attachments into a submission group
-- ============================================================
--
-- Until now a staff send into a submission group was text only:
-- sg_send_begin (115, re-created by 136) writes the pending 'out' row
-- with the table's default type 'text' and no media. The settle trigger
-- (115, submission_group_messages_settle) refuses every UPDATE except
-- pending -> sent | blocked | failed with every other column unchanged,
-- so an attachment's type and media must be written at insert.
--
-- This migration:
--   * moves 136's body of sg_send_begin into an ungranted helper,
--     sg_send_begin_row(group, user, type, body, prefixed, media),
--     the one place a staff out row is inserted;
--   * re-creates sg_send_begin (same signature, same bigint return,
--     same rules) as a wrapper writing type 'text' and no media;
--   * adds sg_send_begin_media(group, user, type, body, prefixed, media)
--     for image | video | document | audio, whose media is a jsonb
--     object with an https `link`. A bad type or media raises 22023
--     before anything is read; otherwise the rules are sg_send_begin's:
--     NULL (nothing written) for a missing group, a 'none' group (136)
--     or a caller sg_can_send refuses, and the insert guard (170)
--     raises 42501 for a group that is not ACTIVE. body / prefixed_body
--     stay NOT NULL for a staff row (170's out_attributed); an empty
--     caption is ''.
--
-- Apply in order, once: re-applying 115 or 136 after 210 re-creates
-- sg_send_begin with its own body, which has rules identical to the
-- wrapper here, so nothing is lost; sg_send_begin_media and the helper
-- are untouched by those files.
--
-- Like 115 and 136, this must be applied by a superuser or BYPASSRLS
-- role (the sg_* functions read RLS-forced tables).
--
-- Re-runnable: CREATE OR REPLACE, REVOKE / GRANT.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '210 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The helper: 136's sg_send_begin, with type and media ----------

-- Not granted to anyone: reached only through sg_send_begin and
-- sg_send_begin_media, which check their own arguments first.
CREATE OR REPLACE FUNCTION public.sg_send_begin_row(
  p_group uuid, p_user uuid, p_type text, p_body text, p_prefixed text, p_media jsonb)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_mode    text;
  v_id      bigint;
BEGIN
  SELECT g.account_id, g.wa_mode INTO v_account, v_mode
    FROM public.submission_groups g WHERE g.id = p_group FOR SHARE;
  IF v_account IS NULL OR v_mode IS DISTINCT FROM 'group' OR NOT public.sg_can_send(p_group, p_user) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.submission_group_messages
    (group_id, account_id, direction, sender_user_id, type, body, prefixed_body, media, send_status)
  VALUES (p_group, v_account, 'out', p_user, p_type, p_body, p_prefixed, p_media, 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 2. sg_send_begin: unchanged contract, over the helper ----------

CREATE OR REPLACE FUNCTION public.sg_send_begin(p_group uuid, p_user uuid, p_body text, p_prefixed text)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.sg_send_begin_row(p_group, p_user, 'text', p_body, p_prefixed, NULL)
$$;

-- ---------- 3. sg_send_begin_media ----------

-- A staff attachment send: p_type image | video | document | audio,
-- p_media a jsonb object whose `link` is an https URL (the stored
-- public URL the gateway fetches). p_body is the caption ('' for none).
CREATE OR REPLACE FUNCTION public.sg_send_begin_media(
  p_group uuid, p_user uuid, p_type text, p_body text, p_prefixed text, p_media jsonb)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('image', 'video', 'document', 'audio') THEN
    RAISE EXCEPTION 'sg_send_begin_media: type % is not image, video, document or audio', coalesce(p_type, 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_media IS NULL OR jsonb_typeof(p_media) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_media -> 'link') IS DISTINCT FROM 'string'
     OR (p_media ->> 'link') !~ '^https://' THEN
    RAISE EXCEPTION 'sg_send_begin_media: media must be an object with an https link'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN public.sg_send_begin_row(p_group, p_user, p_type, p_body, p_prefixed, p_media);
END;
$$;

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.sg_send_begin_row(uuid, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.sg_send_begin(uuid, uuid, text, text),
  public.sg_send_begin_media(uuid, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_send_begin(uuid, uuid, text, text),
  public.sg_send_begin_media(uuid, uuid, text, text, text, jsonb)
  TO service_role;

RESET lock_timeout;
