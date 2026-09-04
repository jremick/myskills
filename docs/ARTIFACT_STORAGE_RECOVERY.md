# Artifact write recovery

The API coordinates object storage and Postgres through `artifact_write_intents`.
This coordination uses the existing table; it does not require a schema migration.

A submission first commits an intent. It then locks that intent before the object
PUT and holds the lock until the artifact metadata and submission commit. The
successful transaction deletes its intent. If the transaction fails, cleanup
locks the same intent and checks for an existing artifact reference before it
deletes any object. Reconciliation skips locked intents, so an old timestamp
cannot make an active publication eligible for deletion.

S3 PUT, GET, and DELETE have a 15-second operation deadline. GET includes response
body consumption. The client aborts timed-out requests and destroys stalled Node
response streams. A timed-out PUT leaves its durable intent because the object
server may still finish the request. Reconciliation can remove that late object
after the intent becomes stale. A failed DELETE also retains the intent and
increments its attempt count.

The server reconciles at startup and every 15 minutes. It considers intents stale
after 15 minutes and handles up to 100 per pass. Failed deletions remain retryable.
The logs report retained intents and reconciliation failures. Operators can check
the queue without changing data:

```sql
SELECT state, last_error, count(*) AS intents,
       min(created_at) AS oldest_created_at,
       min(updated_at) AS oldest_updated_at
FROM artifact_write_intents
GROUP BY state, last_error;
```

Before promotion, drain and stop every API process that uses the old publication
code. Remove old reconciliation workers too. The new lock protocol protects
publications only when all active writers and cleanup workers participate; a
mixed deployment of old and new code does not provide that guarantee. Apply the
same drain rule before a rollback to an older API version. Preserve Postgres and
artifact storage as one recovery point.

The regression tests in `apps/api/test/postgres-skill-registry.pgtest.ts` pause a
real Postgres submission store after object PUT, run stale reconciliation, then
approve, publish, and retrieve the retained bundle. The S3 adapter deadline tests
are in `apps/api/test/artifact-storage.test.ts`.
