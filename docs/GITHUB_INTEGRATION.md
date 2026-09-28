# GitHub source authentication

MySkills can authenticate public GitHub source checks through a user's GitHub
connection or an instance GitHub App installation. This connection is separate
from signing in to MySkills. Private repository imports remain unsupported.

## Configure an instance

Register a GitHub App for the deployment. Use the callback URL shown under
**Admin → GitHub**. Configure only the read permissions needed for repository
metadata and contents. No write permission is needed for source checks.

Enter the app ID, client ID, and client secret in MySkills. To run checks with a
shared organization installation, also supply its installation ID and the app's
private key, then enable installation authentication. An MFA-verified owner or
admin must save these settings. Saving app settings requires connected users to
reconnect to GitHub. Use the connection test to check the app or installation;
complete a user connection to verify user authorization.

For user authorization, GitHub returns users to the API callback, which returns
them to the account screen. `APP_BASE_URL` is the public web URL. Set `API_BASE_URL`
when the public API URL differs from `APP_BASE_URL` followed by `/api`; include
the proxy path when applicable. Register the exact callback URL in GitHub.

Secrets are write-only in the admin interface and encrypted before database
storage. Blank secret fields retain the saved values. Back up the database and
the existing `AUTH_SECRET` through the deployment's secret-management process.
Changing that secret without a migration makes stored GitHub credentials
unreadable, just as it affects existing encrypted authentication data.

App registration and installation are separate setup actions in GitHub. The
software does not register an app or install it in an organization automatically.

## Connect a user

Open **Account → GitHub**, select **Connect GitHub**, and authorize the app in
GitHub. MySkills shows the connected GitHub account. The server refreshes expiring
credentials; an expired refresh token or revoked authorization requires reconnecting.
Disconnecting removes the stored connection from MySkills.

When installation authentication is enabled, source checks use that installation.
Otherwise they use the source owner's connection. Without either configuration,
public checks use anonymous requests. Authentication failures are shown instead
of silently retrying anonymously. Scheduled checks use the source owner's
identity, not the user who happens to be viewing the page.

## Rate limits and retry timing

GitHub's anonymous API allowance is shared by requests from the same outgoing IP.
Authenticated requests use the GitHub user's or installation's allowance.
Authorization headers go only to `api.github.com`; raw-content requests remain
anonymous. Redirects are not followed.

MySkills persists GitHub's reset or retry time in a shared database cooldown.
Checks using that credential wait until the cooldown expires, including manual
checks and checks from another API process. A different user's quota stays
independent. Connecting after an anonymous limit allows checks to use the new
authenticated allowance.

**Next check** shows the scheduled run time. During a cooldown, the interface also
shows when another request is allowed and disables **Check now**. Manual-only
sources show retry availability without promising an automatic check. A countdown
does not itself send a request. A successful check preserves the last good source
snapshot until replacement data has passed the existing validation.

## Verification after setup

1. Apply migrations before starting the updated API and web services.
2. Save and test the app configuration from an MFA-verified admin session.
3. Connect a user through GitHub and check a public repository outside the app's
   organization, such as the source actually used by the team.
4. Confirm the check succeeds, the connection status is correct, and the next
   scheduled check time is shown when scheduling is enabled.
5. Verify the user's disconnect/reconnect flow and the shared installation path
   independently. Automated fixture tests do not establish live GitHub access or
   the organization's installation policy.

See GitHub's [app user authorization guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[installation token guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
and [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
