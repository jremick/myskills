import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OAuthAuthorizationDetails, OAuthConnectionClient } from "../../oauth-api.js";

type PageState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; details: OAuthAuthorizationDetails }
  | { kind: "deciding"; details: OAuthAuthorizationDetails; decision: "approve" | "deny" }
  | { kind: "returning"; clientName: string }
  | { kind: "signin" }
  | { kind: "failed"; message: string; retry: boolean };

const START_ERRORS: Record<string, string> = {
  invalid_client: "This app is not registered with this MySkills server. Remove the connector in your AI app and add it again, or ask your administrator.",
  invalid_redirect_uri: "The app asked MySkills to send you to a return address that is not registered for it, so MySkills will not redirect you. Ask your administrator to check the connector's redirect URI.",
  rate_limited: "Too many connection attempts from this network. Wait a minute, then start again from your AI app.",
};
const GENERIC_START_ERROR = "This connection request could not start. Return to your AI app and start the connection again.";

/**
 * Consent for a remote MCP connection (ChatGPT, Claude and other hosts).
 * The request handle comes from the URL fragment via the app shell; the
 * authorization code only ever travels in the final redirect to the client.
 */
export function ConnectAuthorizePage({
  assignLocation = (url) => window.location.assign(url),
  client,
  error,
  handle,
  onFinished,
  onSignIn,
  signedIn,
}: {
  assignLocation?: (url: string) => void;
  client?: OAuthConnectionClient;
  error: string | null;
  handle: string | null;
  onFinished: () => void;
  onSignIn: () => void;
  signedIn: boolean;
}) {
  const [state, setState] = useState<PageState>({ kind: "idle" });

  const load = useCallback(async () => {
    if (!client || !handle) return;
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", details: await client.inspectAuthorization(handle) });
    } catch (loadError) {
      setState(stateForError(loadError));
    }
  }, [client, handle]);

  useEffect(() => {
    if (error || !signedIn || !handle || !client) return;
    void load();
  }, [client, error, handle, load, signedIn]);

  async function decide(details: OAuthAuthorizationDetails, decision: "approve" | "deny") {
    if (!client || !handle) return;
    setState({ kind: "deciding", details, decision });
    try {
      const { redirectTo } = await client.decideAuthorization(handle, decision);
      // Navigate only to the registered client origin shown on this page.
      let target: URL | null = null;
      try {
        target = new URL(redirectTo);
      } catch {
        target = null;
      }
      if (!target || (target.protocol !== "https:" && target.protocol !== "http:") || target.origin !== details.client.redirectOrigin) {
        setState({ kind: "failed", message: "MySkills could not return you safely to the app. Start the connection again from your AI app.", retry: false });
        return;
      }
      onFinished();
      setState({ kind: "returning", clientName: details.client.name });
      assignLocation(target.href);
    } catch (decisionError) {
      const code = errorCode(decisionError);
      if (code === "MFA_VERIFICATION_REQUIRED") {
        setState({ kind: "ready", details: { ...details, mfaRequired: true } });
        return;
      }
      if (code === "OAUTH_CONNECTION_LIMIT") {
        setState({ kind: "failed", message: "This account has too many active connections. Revoke one in Settings, then start again from your AI app.", retry: false });
        return;
      }
      setState(stateForError(decisionError));
    }
  }

  const details = state.kind === "ready" || state.kind === "deciding" ? state.details : null;
  const heading = details ? `Connect ${details.client.name} to MySkills` : "Connect an AI app to MySkills";

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main className="login-page connect-page" id="main-content">
        <section className="login-panel connect-panel" aria-labelledby="connect-heading" aria-busy={state.kind === "loading" || state.kind === "deciding"}>
          <p className="landing-status">Remote MCP connection</p>
          <h1 id="connect-heading">{heading}</h1>
          {error ? (
            <Notice>{START_ERRORS[error] ?? GENERIC_START_ERROR}</Notice>
          ) : !handle ? (
            <Notice>This connection link is incomplete. Start again from your AI app.</Notice>
          ) : !client ? (
            <Notice>Remote connections are not available in this browser client.</Notice>
          ) : !signedIn || state.kind === "signin" ? (
            <>
              <p>Sign in to MySkills to review this connection request. You will return here afterwards.</p>
              <Button className="shadcn-action-button" size="sm" type="button" onClick={onSignIn}>
                <LogIn size={16} aria-hidden="true" />
                Sign in to continue
              </Button>
            </>
          ) : state.kind === "returning" ? (
            <div className="success-message compact-message" role="status" aria-live="polite">Returning you to {state.clientName}…</div>
          ) : state.kind === "failed" ? (
            <>
              <Notice>{state.message}</Notice>
              {state.retry && <Button size="sm" type="button" variant="outline" onClick={() => void load()}>Try again</Button>}
            </>
          ) : details ? (
            <ConsentDetails
              deciding={state.kind === "deciding" ? state.decision : null}
              details={details}
              onDecide={(decision) => void decide(details, decision)}
              onSignIn={onSignIn}
            />
          ) : (
            <p role="status" aria-live="polite">Loading connection request…</p>
          )}
        </section>
      </main>
    </>
  );
}

function ConsentDetails({
  deciding,
  details,
  onDecide,
  onSignIn,
}: {
  deciding: "approve" | "deny" | null;
  details: OAuthAuthorizationDetails;
  onDecide: (decision: "approve" | "deny") => void;
  onSignIn: () => void;
}) {
  // Legacy servers expose only these two read scopes. Never infer that a new
  // or unknown scope is read-only from its spelling or from a cached session.
  const readOnly = details.scopes.length > 0 && details.scopes.every((scope) =>
    scope.readOnly === true || (scope.readOnly === undefined && ["skills:read", "architectures:read"].includes(scope.scope)));
  const allowsChanges = details.scopes.some((scope) => scope.readOnly === false);
  return (
    <div className="connect-details">
      <dl className="connect-facts">
        <div>
          <dt>App</dt>
          <dd>
            <strong>{details.client.name}</strong>
            <small>
              {details.client.registration === "configured"
                ? "Configured by your MySkills administrator."
                : "Self-registered app. MySkills has not verified who operates it, so check that the return address belongs to the app you are connecting."}
            </small>
          </dd>
        </div>
        <div>
          <dt>Returns you to</dt>
          <dd><code>{details.client.redirectOrigin}</code></dd>
        </div>
        <div>
          <dt>Signed in as</dt>
          <dd><strong>{details.account.email}</strong></dd>
        </div>
      </dl>
      <h2 className="connect-subheading">This app will be able to</h2>
      <ul className="connect-scopes">
        {details.scopes.map((scope) => (
          <li key={scope.scope}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span><code>{scope.scope}</code> {scope.description}</span>
          </li>
        ))}
      </ul>
      <p className="connect-note">
        {readOnly
          ? "This connection is read-only. The app cannot publish, review, change or delete anything in MySkills, and it sees only what your account can see."
          : allowsChanges
            ? "This app can make the changes listed above, within your account permissions. Approve only the access you want this app to have."
            : "This app can use the permissions listed above, within your account permissions. Review each permission before approving access."}
        {" "}Reading a skill does not install or run it. Actions that require MFA may ask you to sign in and verify again.
        Revoke access at any time in Settings under Remote connections.
      </p>
      {details.mfaRequired && (
        <div className="safe-message compact-message connect-mfa" role="status">
          <span>Verify MFA again to approve this connection. Sign in with MFA to approve the permissions listed above.</span>
          <Button size="sm" type="button" variant="outline" onClick={onSignIn}>Sign in with MFA</Button>
          <span>If you have not enabled MFA, <a className="underline underline-offset-2" href="/settings" target="_blank" rel="noopener noreferrer">Set up MFA in Settings</a>, then return here and sign in again.</span>
        </div>
      )}
      <div className="connect-actions">
        <Button className="shadcn-action-button" disabled={details.mfaRequired || deciding !== null} size="sm" type="button" onClick={() => onDecide("approve")}>
          {deciding === "approve" ? "Allowing…" : "Allow access"}
        </Button>
        <Button disabled={deciding !== null} size="sm" type="button" variant="outline" onClick={() => onDecide("deny")}>
          {deciding === "deny" ? "Denying…" : "Deny"}
        </Button>
      </div>
    </div>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <div className="safe-message compact-message connect-notice" role="status" aria-live="polite">
      <CircleAlert size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function stateForError(error: unknown): PageState {
  const status = errorStatus(error);
  const code = errorCode(error);
  if (status === 401) return { kind: "signin" };
  if (code === "OAUTH_REQUEST_EXPIRED") return { kind: "failed", message: "This connection request expired. Return to your AI app and start the connection again.", retry: false };
  if (code === "OAUTH_REQUEST_ALREADY_DECIDED") return { kind: "failed", message: "This connection request was already answered. Start again from your AI app if you still want to connect.", retry: false };
  if (code === "OAUTH_REQUEST_NOT_FOUND") return { kind: "failed", message: "This connection request is not valid. Start again from your AI app.", retry: false };
  if (status === 404) return { kind: "failed", message: "Remote connections are not enabled on this MySkills server.", retry: false };
  if (status === 403) return { kind: "failed", message: "This account cannot approve remote connections from this session.", retry: false };
  return { kind: "failed", message: "Connection details are not available right now.", retry: true };
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
