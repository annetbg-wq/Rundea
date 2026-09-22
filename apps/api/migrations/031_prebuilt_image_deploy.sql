ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS artifact_image_ref text,
  ADD COLUMN IF NOT EXISTS artifact_source_commit_sha text;

CREATE INDEX IF NOT EXISTS deployments_artifact_image_ref_idx
  ON deployments(artifact_image_ref)
  WHERE artifact_image_ref IS NOT NULL;
