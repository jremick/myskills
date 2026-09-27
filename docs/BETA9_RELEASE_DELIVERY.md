# Beta.9 release delivery

Status: candidate prepared; publication and deployment checks are pending.

## Scope

The owner authorized pushing the approved homepage implementation to GitHub,
updating the release and deploying myskills.sh on 27 September 2026. Scope is the
responsive marketing homepage and optional instance-wide landing setting.
App-wide styling and email/outbox work run in separate project chats.

The setting defaults on. Owners and administrators with MFA can save it off,
which sends root visitors to login. Public registry access, existing authentication
flows and package access remain independent. The existing instance_settings table
holds the boolean; setting and audit writes are atomic. No migration is required.

## Candidate verification

The implementation passed the repository check (1,189 passed, two skipped),
all 198 web tests and focused Postgres setting/audit rollback checks. Real local
browser journeys covered responsive layouts, keyboard controls, save/discard,
failed audit rollback, denied non-MFA editing, disabled routing and loading errors.
Opus 5.5 reviewed the design through the personal Claude subscription; runtime
records confirmed xhigh effort. Its final admin-header finding was corrected
and verified at desktop and 390px widths.

The wider local Postgres run had 235 passes, four failures and one cancellation
in notification-outbox tests. The original HEAD store reproduced the same class
of empty-claim/timing failures. This is not a passing release gate. The dedicated
email/outbox chat owns diagnosis; this candidate must still pass required CI and
canonical release verification before promotion.

## Delivery and recovery

Use an immutable candidate on protected main, pass required CI and the canonical
`npm run release:verify`, then verify it on dedicated Railway staging. Deploy the
API and await readiness before the web app. Compare direct API, web and proxy
version responses with the exact candidate and perform rendered browser checks.

Capture a current database-and-artifact recovery point before production. The
current beta.8 source is 55849876639fbb55167496051bd8d573b5a6a6af; production API
fca21294-e5ee-414f-91b8-cc612e4e6203 and web
a53c83e5-33e3-45b4-98f2-b8d8828b221a are the pre-promotion pair. The beta.9
setting row is ignored by beta.8. Retain all beta.8 Libraries security guards;
no data restore or downgrade below beta.8 is part of this rollout.

Create a new immutable v0.1.0-beta.9 tag and GitHub prerelease only after the
documented gates. Do not move beta.8. npm publication is not part of this website
release; its beta selector remains beta.8.
