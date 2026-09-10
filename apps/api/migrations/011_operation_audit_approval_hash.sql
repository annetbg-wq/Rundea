ALTER TABLE operation_audit
  ADD COLUMN IF NOT EXISTS approval_ref_hash text NULL
  CHECK (approval_ref_hash IS NULL OR approval_ref_hash ~ '^[0-9a-f]{64}$');

-- Older builds stored the opaque approval reference itself. It is not needed
-- for audit correlation and must not remain reusable at rest.
ALTER TABLE operation_audit
  DROP COLUMN IF EXISTS approval_ref;
