-- ============================================================
-- 248_intake_file_preview.sql — see the file while sorting (U5).
--
-- A sorter files a desk upload or a tray document without opening it
-- today. Two service-role functions hand the app the stored location of
-- ONE file, after the access check and after an audit row, so the route
-- can sign a short-lived URL (300 s) for a preview beside the sort panel:
--
--  * intake_file_for_preview(actor, account, item): a 220 intake item's
--    file ('case-files' bucket, 'intake/<item id>/<sha256>.<ext>'). The
--    uploader may always see their own file; anyone else only while the
--    item waits 'untagged' and the item's queue is in their sorting scope
--    (intake_scope_ok on queue_bank_code, 220's rule). A filed item is a
--    case file and is read through the case's own download (182).
--  * desk_tray_file_for_preview(actor, account, tray): a 230 tray item's
--    customer document. Only people who may sort it (desk_tray_can_sort,
--    230's rule) and only while it is open.
--
-- Anyone else, another account, a non-staff actor and an unknown id all
-- get the same ITEM_NOT_FOUND / TRAY_NOT_FOUND, so a refusal says nothing
-- about the item. An item with no file is FILE_NOT_FOUND.
--
-- The audit row (desk_file_previews) is written by the same call, BEFORE
-- the app signs anything: a preview that produced no URL still leaves its
-- row (182's order). It holds ids and a time only, never a URL, a path or
-- a file name. Append-only; no foreign key on the item / tray id so a
-- contact erasure that deletes a tray row (222) is never blocked by it.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- table forces RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role (the functions read 220/230's RLS-forced tables).
-- Re-runnable; restates no other migration's function. Asserted by
-- supabase/ci/verify-intake-file-preview.sql. docs/case-desk.md.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '248 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.intake_scope_ok(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public.desk_tray_can_sort(uuid, uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION '248 needs migrations 220 and 230 applied first';
  END IF;
END $$;

-- ---------- 1. The audit table ----------

CREATE TABLE IF NOT EXISTS public.desk_file_previews (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES public.accounts(id),
  actor_id        uuid NOT NULL,
  intake_item_id  uuid NULL,
  tray_id         uuid NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_file_previews_one_target CHECK ((intake_item_id IS NULL) <> (tray_id IS NULL))
);
CREATE INDEX IF NOT EXISTS desk_file_previews_item_idx
  ON public.desk_file_previews (intake_item_id, at) WHERE intake_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS desk_file_previews_tray_idx
  ON public.desk_file_previews (tray_id, at) WHERE tray_id IS NOT NULL;
COMMENT ON TABLE public.desk_file_previews IS
  'Append-only: who asked to preview which desk upload or tray document, and when. No URL, path or name. Migration 248.';

DROP TRIGGER IF EXISTS desk_file_previews_no_update ON public.desk_file_previews;
CREATE TRIGGER desk_file_previews_no_update BEFORE UPDATE ON public.desk_file_previews
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS desk_file_previews_no_delete ON public.desk_file_previews;
CREATE TRIGGER desk_file_previews_no_delete BEFORE DELETE ON public.desk_file_previews
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS desk_file_previews_no_truncate ON public.desk_file_previews;
CREATE TRIGGER desk_file_previews_no_truncate BEFORE TRUNCATE ON public.desk_file_previews
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

ALTER TABLE public.desk_file_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_file_previews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_file_previews FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. An intake item's file ----------

CREATE OR REPLACE FUNCTION public.intake_file_for_preview(p_actor uuid, p_account uuid, p_item uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (storage_path text, mime text, original_name text, size_bytes bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  i public.intake_items%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.intake_items x WHERE x.id = p_item AND x.account_id = p_account;
  IF NOT FOUND
     OR public.case_account_role(p_account, p_actor) IS NULL
     OR NOT (i.uploaded_by = p_actor
             OR (i.state = 'untagged' AND public.intake_scope_ok(p_actor, p_account, i.queue_bank_code))) THEN
    PERFORM public.desk_refuse('intake_file_for_preview', 'ITEM_NOT_FOUND', 'item not found');
  END IF;
  IF i.storage_path IS NULL THEN
    PERFORM public.desk_refuse('intake_file_for_preview', 'FILE_NOT_FOUND', 'the item has no file');
  END IF;
  INSERT INTO public.desk_file_previews (account_id, actor_id, intake_item_id, at)
  VALUES (p_account, p_actor, i.id, coalesce(p_now, now()));
  RETURN QUERY SELECT i.storage_path, i.mime, i.original_name, i.size_bytes;
END;
$$;

-- ---------- 3. A tray item's customer document ----------

CREATE OR REPLACE FUNCTION public.desk_tray_file_for_preview(p_actor uuid, p_account uuid, p_tray uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (storage_bucket text, storage_path text, media_url text, mime text, original_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  t public.desk_tray%ROWTYPE;
  d public.customer_documents%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray AND x.account_id = p_account;
  IF NOT FOUND
     OR public.case_account_role(p_account, p_actor) IS NULL
     OR t.state <> 'open'
     OR NOT public.desk_tray_can_sort(p_actor, p_account, t.candidates) THEN
    PERFORM public.desk_refuse('desk_tray_file_for_preview', 'TRAY_NOT_FOUND', 'tray item not found');
  END IF;
  SELECT * INTO d FROM public.customer_documents x
   WHERE x.id = t.customer_document_id AND x.account_id = p_account;
  IF NOT FOUND THEN
    PERFORM public.desk_refuse('desk_tray_file_for_preview', 'FILE_NOT_FOUND', 'the document is gone');
  END IF;
  INSERT INTO public.desk_file_previews (account_id, actor_id, tray_id, at)
  VALUES (p_account, p_actor, t.id, coalesce(p_now, now()));
  RETURN QUERY SELECT d.storage_bucket, d.storage_path, d.media_url, d.mime, d.original_name;
END;
$$;

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.intake_file_for_preview(uuid, uuid, uuid, timestamptz),
  public.desk_tray_file_for_preview(uuid, uuid, uuid, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.intake_file_for_preview(uuid, uuid, uuid, timestamptz),
  public.desk_tray_file_for_preview(uuid, uuid, uuid, timestamptz)
TO service_role;
