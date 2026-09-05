# Independent-user pilot

Status: ready for participant selection; not started. No independent-user
completion or adoption evidence has been collected for this pilot.

The goal is for people outside the implementation team to produce, review, and
use one useful skill, then safely update, recover, and withdraw it. This tests
the [product goal](PRODUCT_BRIEF.md) through the completed
[operational beta](OPERATIONAL_BETA_DELIVERY.md). Automated acceptance results
remain separate evidence.

## Participants and run record

Prefer three people with separate accounts. With two people, the reviewer may
also perform the consumer tasks through a separate ordinary-user account and
browser profile. Record that overlap; it is two participants, not three.
The author must not review their own submission. The builder observes and
records interventions, without acting as a participant.

| Role | Participant | Required access |
| --- | --- | --- |
| Author | Unassigned | Active account with `author` role |
| Reviewer | Unassigned | Active account with `maintainer` role and MFA-verified session |
| Consumer | Unassigned | Active `user` account, its own personal architecture and workspace, MFA-verified session for enrollment |

Before scheduling, the operator records the run ID, date, approved registry web
and API URLs, deployed revision, exact CLI version, participant aliases, allowed
skill visibility, and private evidence location. Select a registry where the
reviewer's maintainer access is appropriate. Do not grant owner/admin access to
make a task pass. Accounts, invitations, email delivery, and recovery readiness
are operator prerequisites, not tasks completed by this document.

## Prerequisites

- Allow 60–90 minutes together, plus separately timed account setup. Each person
  uses their own credentials. Enable MFA through security settings where needed,
  then sign in again; enrollment alone does not upgrade an existing session.
- The consumer needs macOS or Linux, Node `>=22.13 <23` or `>=24 <25`, and Codex
  already available. The operator supplies a verified beta.5 CLI installation
  from the published release or its verified tarball. Record `myskills --version`;
  do not assume the npm `beta` tag identifies the intended artifact.
- Use an existing, empty disposable workspace with an absolute path. Do not use
  a home directory, global Codex directory, or working project. Set aside a
  second empty directory for the final denied-download check.
- Agree on a non-sensitive input and output rubric before starting. Use the
  [release-notes example](../examples/skills/release-notes-helper) as the package
  starting point. Work on a copy with a unique `pilot-<run>-release-notes` name in
  both `skill.json` and `SKILL.md` frontmatter. Keep the license and Codex platform
  declaration. Prefer `authenticated` visibility if enabled; this is visible to
  other signed-in users, so include no private content. Confirm any other
  visibility with the operator before submission.
- Agree on using the participant's existing Codex session for the useful-output
  check, including its normal usage cost. No new provider or API credential is
  needed. If that use is unavailable, record discovery and installation only;
  the working-skill outcome remains untested.

## Task cards

Give participants this document and the [CLI README](../apps/cli/README.md).
Documentation use counts as unaided. Builder hints, commands supplied outside
these documents, account repairs, or manual data changes count as assistance.
Record the original attempt before helping; do not relabel a coached retry.

1. **Author — submit a first version.** Adapt the example to the agreed task as
   `0.1.0`. Validate and scan the package, resolve blocking findings, and submit
   it. The reviewer must locate this submission under their own account.
2. **Reviewer and author — complete a correction.** Inspect the package and scan
   findings. Request one concrete improvement, such as an example showing how
   missing verification evidence must be reported. The author opens **View
   feedback for 0.1.0**, explains the requested change, and corrects the package
   as `0.1.1`. Submit it with release notes. The original submission and review
   reason must remain visible; do not overwrite or publish `0.1.0`.
3. **Reviewer — publish what was inspected.** Inspect the corrected package,
   verify the requested change and scan results, approve that exact artifact,
   then publish `0.1.1`. Record the approved version and artifact digest in the
   private run record. The author must not perform these review actions.
4. **Consumer — discover and inspect.** Find the skill without a supplied direct
   link. Explain who owns it, which version is available, its compatibility, and
   what it will do. Use **Inspect package files** to read `SKILL.md` and one
   supporting file as text. Record whether the evidence is sufficient to decide
   to install; do not equate an approved scan with a guarantee of useful output.
5. **Consumer — install and use it.** In Architectures, create a personal **Flat
   library**. In its first-revision workbench, search for the pilot skill, choose
   **Exact release** `0.1.1`, select **Add selected exact release**, then **Save
   revision**. Note its architecture ID. The saved
   **Architecture spec JSON** under **Add immutable revision** shows the profile
   and environment IDs; read these values without submitting another revision.
   Enroll the disposable workspace, install exactly `0.1.1`, and upload an
   observation. Open that workspace in Codex and confirm the named skill appears
   in its skill discovery UI. Invoke it explicitly on the agreed input and assess
   the output rubric. A successful filesystem observation alone does not finish
   this task. Record any help needed to obtain the architecture IDs.
6. **Author, reviewer, consumer — update.** Add one observable improvement as
   `0.2.0`, for example an **Operator actions** output section, with accurate
   release notes and change kind. Repeat independent review and publication.
   The consumer previews the update, states what will change, applies exactly
   `0.2.0`, and verifies both the installed version and changed package text.
7. **Consumer — recover.** Roll back and verify `0.1.1` is installed with its
   original package text. Upload another observation. Explain which version is
   active and why. Do not edit managed files to simulate a successful rollback.
8. **Reviewer and consumer — revoke.** After recovery is verified, the reviewer
   uses **Manage skills** to revoke both published releases, `0.1.1` and `0.2.0`,
   with a pilot-completion reason. The consumer refreshes discovery and attempts
   an export of `0.1.1` into the unused directory: it must be denied with no
   package delivered. Explain that revocation blocks future registry delivery;
   it does not erase an already installed copy. The consumer then revokes their
   disposable connected target through **Revoke target** and confirms a new
   uploaded observation is refused. Keep lifecycle/audit history; do not delete
   records to hide failures.

For the reference task, supply two reviewed changes (a truncated-search fix and
Markdown export), one known limitation, and no verification results. The output
passes only if it includes both changes and the limitation, marks verification
as not supplied, and invents no changes or successful tests. Set any task-specific
word limit before the attempt. Record actual usefulness separately from format.

## Command reference

Replace the quoted placeholders with this run's values. Sign in separately for
each role on its own machine or OS account; do not pass credentials in commands.
Successful login saves the selected API URL. The commands below are supported by
the current [CLI implementation](../apps/cli/src/cli.ts).

```sh
myskills --version
myskills login --api-url "API_URL"
myskills auth status
myskills doctor

# Author: repeat after changing the manifest version and package contents.
myskills validate --path "/absolute/path/pilot-package"
myskills scan --path "/absolute/path/pilot-package"
myskills submit --path "/absolute/path/pilot-package" \
  --release-notes-file "/absolute/path/release-notes.md" --change-kind fix

# Consumer: create the workspace directory before enrollment.
myskills search "PILOT_SLUG"
myskills info "PILOT_SLUG"
myskills architectures list
myskills codex enroll --workspace "/absolute/path/pilot-workspace" \
  --architecture-id "ARCHITECTURE_ID" --environment-id "ENVIRONMENT_ID" \
  --profile-id "PROFILE_ID" --name "Pilot workspace"
myskills install "PILOT_SLUG" --version 0.1.1 --workspace "/absolute/path/pilot-workspace"
myskills list --workspace "/absolute/path/pilot-workspace"
myskills codex observe --workspace "/absolute/path/pilot-workspace" --upload

# After independent review and publication of 0.2.0:
myskills update "PILOT_SLUG" --version 0.2.0 --dry-run --workspace "/absolute/path/pilot-workspace"
myskills update "PILOT_SLUG" --version 0.2.0 --workspace "/absolute/path/pilot-workspace"
myskills list --workspace "/absolute/path/pilot-workspace"
myskills rollback "PILOT_SLUG" --workspace "/absolute/path/pilot-workspace"
myskills list --workspace "/absolute/path/pilot-workspace"
myskills codex observe --workspace "/absolute/path/pilot-workspace" --upload

# After the reviewer revokes both published releases: expect denial.
myskills export "PILOT_SLUG" --version 0.1.1 --platform codex \
  --output "/absolute/path/pilot-denied-export"
# After the consumer revokes the target: expect refusal.
myskills codex observe --workspace "/absolute/path/pilot-workspace" --upload
```

Use `--change-kind feature` for the added output section; `fix` fits the requested
correction. Keep each version's release notes accurate. This pilot uses explicit
CLI updates and rollback. Browser-queued companion execution and full-range
policy enforcement have separate [operational acceptance](OPERATIONAL_ACCEPTANCE.md)
coverage; completing these task cards does not count as an independent test of
those paths.

## Measures, evidence, and decision

Record task start/end times, result, intervention count, and the participant's
expectation before each action. Time to first working skill runs from the start
of consumer discovery through the first output that meets the agreed rubric;
it includes package inspection, architecture setup, enrollment, and runtime
discovery. Record account/CLI setup separately, and report both the total elapsed
time and any external wait time. Do not subtract troubleshooting or report only
the fastest retry.

Keep a private row per task: run ID, participant alias/role, task number, elapsed
minutes, unaided/assisted/blocked, expected/actual result, safe error code, and
evidence reference. With participant consent, capture the relevant UI, CLI
version/result, and output rubric. Never record passwords, MFA/recovery codes,
tokens, full terminal histories, or unrelated workspace content. Redact account
labels and private locators from screenshots. Keep raw evidence outside source
control; agree on its owner and deletion date before recording. Registry package
reads can create normal audit events. This pilot also deliberately creates
submission, review, release, target, and observation records.

Ask each person: Where did you hesitate? What did you expect? Could you explain
the active version and revocation effect? Would this replace part of a real task,
and why? Request one concrete next use rather than a satisfaction score alone.
Record verbatim quotes only with consent. A stated intention is not repeat use.

The proposed gate for continuing a small beta is:

- All three role paths finish; the author and reviewer are different people.
  At least two independent people participate, with any role overlap reported.
- Tasks 1–8 pass on their first attempt without builder assistance, and the
  consumer reaches a working skill within 30 minutes. Report each result and
  time, not a percentage that hides this small sample.
- Update, rollback, release revocation, and target revocation meet every expected
  result. There is no unauthorized access, lost local work, or wrong artifact.
- The consumer identifies a credible repeat use. Count adoption only after an
  actual later unaided use is separately observed or reported with evidence.

If any gate fails, record **revise and repeat** for the affected path with a new
unaided attempt; retain the original result. Stop immediately for unexpected
private-data exposure, authorization bypass, incorrect artifact delivery, loss
of local work, or changes outside the pilot resources. Stop a task after ten
minutes without progress, record it as blocked, and offer assistance only after
capturing the failure. Participants may stop at any time. The operator handles
incidents and cleanup; do not reset shared data or weaken controls to continue.

Passing supports a bounded OSS beta usability claim. It does not establish
stable readiness, sustained adoption, broad platform compatibility, general
architecture execution, model reliability, email deliverability, or recurring
backup/recovery targets. Those remain separate work and evidence in the
[delivery ledger](OPERATIONAL_BETA_DELIVERY.md).
