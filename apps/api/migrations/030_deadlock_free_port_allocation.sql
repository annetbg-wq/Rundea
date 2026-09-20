-- Avoid advisory-lock deadlocks during concurrent managed port allocation.
-- Correctness is enforced by the existing PRIMARY KEY(service_id,node_id) and
-- UNIQUE(node_id,host_port) constraints. Competing transactions race on those
-- constraints; losers retry another candidate or reuse the allocation created
-- for the same service.

CREATE OR REPLACE FUNCTION rundea_allocate_host_port(input_service_id uuid, input_node_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  existing_port integer;
  candidate integer;
  inserted_port integer;
BEGIN
  SELECT host_port INTO existing_port
    FROM service_port_allocations
   WHERE service_id=input_service_id AND node_id=input_node_id;
  IF existing_port IS NOT NULL THEN
    RETURN existing_port;
  END IF;

  FOR candidate IN 18000..29999 LOOP
    INSERT INTO service_port_allocations(service_id,node_id,host_port)
    VALUES(input_service_id,input_node_id,candidate)
    ON CONFLICT DO NOTHING
    RETURNING host_port INTO inserted_port;

    IF inserted_port IS NOT NULL THEN
      RETURN inserted_port;
    END IF;

    -- A concurrent transaction may have created the stable allocation for this
    -- service while we were waiting on a uniqueness check.
    SELECT host_port INTO existing_port
      FROM service_port_allocations
     WHERE service_id=input_service_id AND node_id=input_node_id;
    IF existing_port IS NOT NULL THEN
      RETURN existing_port;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'no Rundea-managed host ports are available on node %', input_node_id;
END;
$$;
