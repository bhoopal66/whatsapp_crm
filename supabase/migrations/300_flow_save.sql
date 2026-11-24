-- ============================================================
-- 300_flow_save.sql — saving a flow in one transaction (audit 2026-11-24)
--
-- The route updated the flow, deleted its nodes and inserted the new ones
-- in three calls: a refused insert left a live flow with no nodes, a
-- customer's message in between ended their run, and the last of two
-- saves silently won. flow_save does it at once, in place by node_key,
-- and refuses when the flow was saved since the caller loaded it.
--
-- flows.edited_at / edited_by: the last save of the flow's CONTENT, NULL
-- before the first one through flow_save. updated_at cannot say it: it
-- moves on every counted run and status change. A flow's version is
-- coalesce(edited_at, created_at).
--
-- SECURITY INVOKER: RLS (135) decides, so an admin of the ACTIVE account
-- saves and everybody else finds no flow. The previous build's separate
-- writes keep working. Re-runnable. Apply before the build.
-- Asserted by supabase/ci/verify-flow-save.sql.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- p_patch holds only the columns to change; p_nodes NULL leaves the nodes
-- alone; p_expected NULL is not checked.
CREATE OR REPLACE FUNCTION public.flow_save(
  p_flow uuid,
  p_patch jsonb,
  p_nodes jsonb,
  p_expected timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_created timestamptz;
  v_version timestamptz;
  v_updated timestamptz;
  v_key text;
BEGIN
  -- NO KEY UPDATE: starting a run (its foreign key) must not wait on a save.
  SELECT f.created_at, coalesce(f.edited_at, f.created_at)
    INTO v_created, v_version
    FROM public.flows f WHERE f.id = p_flow
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'flow not found' USING ERRCODE = 'no_data_found', HINT = 'FLOW_NOT_FOUND';
  END IF;
  IF p_expected IS NOT NULL AND p_expected <> v_version THEN
    RAISE EXCEPTION 'the flow was saved by somebody else'
      USING ERRCODE = 'check_violation', HINT = 'FLOW_CHANGED', DETAIL = v_version::text;
  END IF;

  -- updated_at is the table's own trigger's.
  UPDATE public.flows f SET
    name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE f.name END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE f.description END,
    trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE f.trigger_type END,
    trigger_config = CASE WHEN p_patch ? 'trigger_config'
                          THEN NULLIF(p_patch->'trigger_config', 'null'::jsonb) ELSE f.trigger_config END,
    entry_node_id = CASE WHEN p_patch ? 'entry_node_id' THEN p_patch->>'entry_node_id' ELSE f.entry_node_id END,
    fallback_policy = CASE WHEN p_patch ? 'fallback_policy'
                           THEN NULLIF(p_patch->'fallback_policy', 'null'::jsonb) ELSE f.fallback_policy END,
    -- Always later than the version it replaces, whatever the clock does.
    edited_at = greatest(clock_timestamp(), v_version + interval '1 microsecond'),
    edited_by = auth.uid()
  WHERE f.id = p_flow
  RETURNING f.edited_at, f.updated_at INTO v_version, v_updated;

  IF jsonb_typeof(p_nodes) = 'array' THEN
    SELECT n.node_key INTO v_key
      FROM jsonb_to_recordset(p_nodes) AS n(node_key text)
     GROUP BY n.node_key HAVING count(*) > 1 LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'two steps have the key "%"', v_key
        USING ERRCODE = 'unique_violation', HINT = 'FLOW_DUPLICATE_KEY', DETAIL = coalesce(v_key, '');
    END IF;

    DELETE FROM public.flow_nodes s
     WHERE s.flow_id = p_flow
       AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_nodes) AS n(node_key text)
                        WHERE n.node_key = s.node_key);

    -- created_at is what the editor lists nodes by, so it carries the
    -- order they were sent in (an updated row moves in the heap, which is
    -- what ordered them while all were inserted at once).
    INSERT INTO public.flow_nodes AS s
           (flow_id, node_key, node_type, config, position_x, position_y, created_at)
    SELECT p_flow, n.node->>'node_key', n.node->>'node_type',
           coalesce(NULLIF(n.node->'config', 'null'::jsonb), '{}'::jsonb),
           coalesce((n.node->>'position_x')::integer, 0),
           coalesce((n.node->>'position_y')::integer, 0),
           v_created + n.ord * interval '1 microsecond'
      FROM jsonb_array_elements(p_nodes) WITH ORDINALITY AS n(node, ord)
    ON CONFLICT (flow_id, node_key) DO UPDATE SET
      node_type = EXCLUDED.node_type,
      config = EXCLUDED.config,
      position_x = EXCLUDED.position_x,
      position_y = EXCLUDED.position_y,
      created_at = EXCLUDED.created_at
    WHERE (s.node_type, s.config, s.position_x, s.position_y, s.created_at)
          IS DISTINCT FROM
          (EXCLUDED.node_type, EXCLUDED.config, EXCLUDED.position_x, EXCLUDED.position_y, EXCLUDED.created_at);
  END IF;

  RETURN jsonb_build_object('edited_at', v_version, 'updated_at', v_updated);
END $$;

REVOKE ALL ON FUNCTION public.flow_save(uuid, jsonb, jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flow_save(uuid, jsonb, jsonb, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
