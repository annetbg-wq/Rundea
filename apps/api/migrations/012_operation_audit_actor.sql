ALTER TABLE operation_audit
  ADD COLUMN IF NOT EXISTS authn_method text NULL,
  ADD COLUMN IF NOT EXISTS actor_issuer text NULL,
  ADD COLUMN IF NOT EXISTS actor_subject text NULL,
  ADD COLUMN IF NOT EXISTS actor_scopes text[] NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operation_audit_authn_method_check'
  ) THEN
    ALTER TABLE operation_audit
      ADD CONSTRAINT operation_audit_authn_method_check
      CHECK (authn_method IS NULL OR authn_method IN ('STATIC_TOKEN','OAUTH'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operation_audit_actor_issuer_check'
  ) THEN
    ALTER TABLE operation_audit
      ADD CONSTRAINT operation_audit_actor_issuer_check
      CHECK (actor_issuer IS NULL OR char_length(actor_issuer) BETWEEN 1 AND 2048);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operation_audit_actor_subject_check'
  ) THEN
    ALTER TABLE operation_audit
      ADD CONSTRAINT operation_audit_actor_subject_check
      CHECK (actor_subject IS NULL OR char_length(actor_subject) BETWEEN 1 AND 256);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operation_audit_actor_shape_check'
  ) THEN
    ALTER TABLE operation_audit
      ADD CONSTRAINT operation_audit_actor_shape_check
      CHECK (
        (authn_method IS NULL AND actor_issuer IS NULL AND actor_subject IS NULL AND actor_scopes IS NULL)
        OR
        (
          authn_method = 'STATIC_TOKEN'
          AND actor_issuer IS NULL
          AND actor_subject IS NULL
          AND actor_scopes IS NOT NULL
          AND cardinality(actor_scopes) = 0
        )
        OR
        (
          authn_method = 'OAUTH'
          AND actor_issuer IS NOT NULL
          AND actor_subject IS NOT NULL
          AND actor_scopes IS NOT NULL
          AND cardinality(actor_scopes) BETWEEN 1 AND 32
        )
      );
  END IF;
END
$$;
