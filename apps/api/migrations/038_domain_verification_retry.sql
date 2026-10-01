ALTER TABLE service_domains
  ADD COLUMN IF NOT EXISTS verification_stage text NOT NULL DEFAULT 'DNS_RESOLVING'
    CHECK (verification_stage IN ('DNS_RESOLVING','DNS_OK','INGRESS_APPLIED','TLS_ISSUING','HTTPS_VERIFYING','ACTIVE','FAILED')),
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_probe_at timestamptz;

UPDATE service_domains
   SET verification_stage=CASE
     WHEN status='ACTIVE' THEN 'ACTIVE'
     WHEN status='FAILED' THEN 'FAILED'
     WHEN status='CONFIGURING' THEN 'HTTPS_VERIFYING'
     ELSE 'DNS_RESOLVING'
   END
 WHERE verification_stage='DNS_RESOLVING';

CREATE INDEX IF NOT EXISTS service_domains_retry_idx
  ON service_domains(next_retry_at)
  WHERE status='PENDING' AND next_retry_at IS NOT NULL;
