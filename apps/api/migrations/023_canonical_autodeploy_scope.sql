-- RUNDEA DOGFOOD GATE v1: canonical push autodeploy uses the stable service_id.
-- Legacy callers still fall back to the hidden migration service identity, but
-- a canonical runtime key already registered in service_autodeploys resolves to
-- its real service before the legacy fallback is considered.

CREATE OR REPLACE FUNCTION rundea_legacy_service_id(input_service_name text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  digest text;
  resolved_id uuid;
BEGIN
  IF input_service_name IS NULL OR input_service_name = '' THEN
    RAISE EXCEPTION 'legacy service_name is required';
  END IF;

  SELECT a.service_id INTO resolved_id
    FROM service_autodeploys a
   WHERE a.service_name=input_service_name
     AND a.service_id IS NOT NULL
   LIMIT 1;
  IF resolved_id IS NOT NULL THEN
    RETURN resolved_id;
  END IF;

  digest := md5('rundea-service:' || input_service_name);
  resolved_id := (
    substr(digest,1,8) || '-' || substr(digest,9,4) || '-' || substr(digest,13,4) || '-' ||
    substr(digest,17,4) || '-' || substr(digest,21,12)
  )::uuid;

  INSERT INTO services(id,project_id,slug,name)
  VALUES(
    resolved_id,
    '00000000-0000-4000-8000-000000000002'::uuid,
    'legacy-' || substr(digest,1,16),
    input_service_name
  )
  ON CONFLICT DO NOTHING;

  RETURN resolved_id;
END;
$$;
