-- Quota belongs to the GitHub user/installation, not an individual library entry.
CREATE TABLE github_source_cooldowns (
  bucket text PRIMARY KEY CHECK (length(bucket) BETWEEN 1 AND 200),
  retry_available_at timestamptz NOT NULL
);

-- Every source request before this feature was anonymous. Preserve its known
-- wait window during upgrade; an authenticated credential has its own bucket.
INSERT INTO github_source_cooldowns (bucket, retry_available_at)
SELECT 'github:anonymous', max(next_check_at)
FROM library_entries
WHERE health = 'rate-limited' AND next_check_at > now()
HAVING max(next_check_at) IS NOT NULL;
