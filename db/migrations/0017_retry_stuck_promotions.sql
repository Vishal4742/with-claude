-- Feed rows whose promotion failed before the sync learned to retry: state
-- 'promoted', no event, and the real fingerprint stored, so every run filed
-- them as unchanged. The 'pending:' marker makes the next sync retry them
-- without counting the retry as an organiser edit.
UPDATE "event_source_records"
   SET "raw_hash" = 'pending:' || "raw_hash"
 WHERE "state" = 'promoted'
   AND "event_id" IS NULL
   AND "raw_hash" NOT LIKE 'pending:%';
