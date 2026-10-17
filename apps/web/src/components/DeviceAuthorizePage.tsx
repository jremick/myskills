import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { DeviceLoginClient } from "../device-login-api.js";
import {
  SIGN_IN_TEXT,
  clearDeviceDraft,
  deviceApproveControl,
  deviceDenyControl,
  devicePermissionLines,
  initialDeviceModel,
  readDeviceDraft,
  reduceDevice,
  writeDeviceDraft,
  type DeviceModel,
  type DeviceStepUp,
} from "../sign-in-flow.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function DeviceAuthorizePage({
  client,
  signedIn,
  onSignIn,
  stepUp,
}: {
  client?: DeviceLoginClient;
  signedIn: boolean;
  onSignIn: () => void;
  stepUp: DeviceStepUp;
}) {
  const [model, dispatch] = useReducer(reduceDevice, undefined, () => initialDeviceModel({
    signedIn,
    hasClient: Boolean(client),
    draft: readDeviceDraft(),
  }));
  const [verified, setVerified] = useState(false);
  const profilePending = useRef(false);
  const stepUpRef = useRef(stepUp);
  stepUpRef.current = stepUp;
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [signedOutCode, setSignedOutCode] = useState(() => {
    const draft = readDeviceDraft();
    return draft?.kind === "entry" ? draft.userCode : "";
  });

  useEffect(() => {
    if (model.kind === "done") {
      clearDeviceDraft();
      return;
    }
    if (model.kind === "code" && model.draft.trim()) {
      writeDeviceDraft({ kind: "entry", userCode: model.draft });
      return;
    }
    if (model.kind === "review" || model.kind === "verify" || model.kind === "enroll") {
      writeDeviceDraft({ kind: "reviewed", userCode: model.userCode });
    }
  }, [model]);

  useEffect(() => {
    if (!client) return;
    const userCode = inspectCode(model);
    if (!userCode) return;
    let active = true;
    async function inspect() {
      if (profilePending.current) {
        await stepUpRef.current.refreshProfile?.();
        profilePending.current = false;
      }
      if (!client || !userCode) throw new Error("Device request unavailable.");
      return client.inspect(userCode);
    }
    inspect().then((consent) => {
      if (active) {
        setVerified(false);
        dispatch({ type: "inspected", userCode, consent });
      }
    }).catch((error: unknown) => {
      if (active) dispatch({ type: "inspect_failed", message: messageOf(error) });
    });
    return () => {
      active = false;
    };
  }, [client, model]);

  function signIn(event: FormEvent) {
    event.preventDefault();
    writeDeviceDraft(signedOutCode.trim() ? { kind: "entry", userCode: signedOutCode } : { kind: "return" });
    onSignIn();
  }

  async function decide(decision: "approve" | "deny") {
    if (!client || (model.kind !== "review" && model.kind !== "verify" && model.kind !== "enroll")) return;
    if (decision === "approve" && deviceApproveControl(model) !== "enabled") return;
    if (decision === "deny" && deviceDenyControl(model) !== "enabled") return;
    const userCode = model.userCode;
    dispatch(decision === "approve" ? { type: "submit_approve" } : { type: "submit_deny" });
    try {
      const result = await client.decide(userCode, decision);
      dispatch({ type: "decided", outcome: result.status });
    } catch (error) {
      if (decision === "approve" && errorCode(error) === "MFA_VERIFICATION_REQUIRED") {
        dispatch({ type: "needs_fresh_mfa" });
        return;
      }
      dispatch({ type: "decision_failed", message: messageOf(error) });
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (model.kind !== "verify" || model.challengeToken !== null || model.inflight !== null) return;
    dispatch({ type: "submit_password" });
    try {
      const result = await stepUp.login({ email: model.consent.accountEmail, password });
      setPassword("");
      if (result.kind === "challenge") dispatch({ type: "challenge", challengeToken: result.challengeToken });
      else dispatch({ type: "step_up_signed_in" });
    } catch (error) {
      dispatch({ type: "step_up_failed", message: messageOf(error) });
    }
  }

  async function submitOtp(event: FormEvent) {
    event.preventDefault();
    if (model.kind !== "verify" || model.challengeToken === null || model.inflight !== null) return;
    const challengeToken = model.challengeToken;
    dispatch({ type: "submit_otp" });
    try {
      await stepUp.verify({ challengeToken, code: otp });
      setOtp("");
      setVerified(true);
      profilePending.current = true;
      dispatch({ type: "verified" });
    } catch (error) {
      dispatch({ type: "step_up_failed", message: messageOf(error) });
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main className="login-page" id="main-content">
        <section className="login-panel device-panel" aria-labelledby="device-heading">
          <h1 id="device-heading">Authorize CLI access</h1>
          <p>{SIGN_IN_TEXT.deviceIntro}</p>
          {model.kind === "signed_out" ? (
            <form className="auth-widget auth-form" onSubmit={signIn}>
              <label className="auth-field" htmlFor="device-code">
                <span>Device code</span>
                <Input className="auth-input" id="device-code" value={signedOutCode} onChange={(event) => setSignedOutCode(event.target.value)} maxLength={32} autoComplete="off" autoCapitalize="characters" />
              </label>
              <Button type="submit">Sign in</Button>
            </form>
          ) : model.kind === "unavailable" ? (
            <p role="alert">{SIGN_IN_TEXT.deviceUnavailable}</p>
          ) : model.kind === "code" ? (
            <form className="auth-widget auth-form" onSubmit={(event) => { event.preventDefault(); dispatch({ type: "submit_code" }); }}>
              {model.error && <p role="alert">{model.error}</p>}
              <label className="auth-field" htmlFor="device-code">
                <span>Device code</span>
                <Input className="auth-input" id="device-code" value={model.draft} onChange={(event) => dispatch({ type: "draft", value: event.target.value })} maxLength={32} autoComplete="off" autoCapitalize="characters" disabled={model.inflight !== null} required />
              </label>
              <Button type="submit" disabled={model.inflight !== null || !model.draft.trim()}>Review permissions</Button>
            </form>
          ) : model.kind === "done" ? (
            <p role="status">CLI access {model.outcome}. Return to the terminal.</p>
          ) : (
            <ConsentPanel verified={verified} onRestart={() => { setOtp(""); setPassword(""); setVerified(false); dispatch({ type: "restart_verification" }); }} model={model} otp={otp} password={password} onDecide={(decision) => void decide(decision)} onOtp={setOtp} onPassword={setPassword} onRecheck={() => dispatch({ type: "recheck" })} onSubmitOtp={(event) => void submitOtp(event)} onSubmitPassword={(event) => void submitPassword(event)} />
          )}
        </section>
      </main>
    </>
  );
}

function ConsentPanel({
  verified,
  onRestart,
  model,
  otp,
  password,
  onDecide,
  onOtp,
  onPassword,
  onRecheck,
  onSubmitOtp,
  onSubmitPassword,
}: {
  verified: boolean;
  onRestart: () => void;
  model: Extract<DeviceModel, { kind: "review" | "verify" | "enroll" }>;
  otp: string;
  password: string;
  onDecide: (decision: "approve" | "deny") => void;
  onOtp: (value: string) => void;
  onPassword: (value: string) => void;
  onRecheck: () => void;
  onSubmitOtp: (event: FormEvent) => void;
  onSubmitPassword: (event: FormEvent) => void;
}) {
  const approve = deviceApproveControl(model);
  const deny = deviceDenyControl(model);
  return (
    <>
      {model.error && <p role="alert">{model.error}</p>}
      <p>{SIGN_IN_TEXT.signedInAs} <strong>{model.consent.accountEmail}</strong></p>
      <p>Device code: <strong>{model.userCode}</strong></p>
      <p>The CLI requests these permissions:</p>
      <ul>{devicePermissionLines(model.consent.scopes).map((line) => <li key={line.key}>{line.text}</li>)}</ul>
      <p>Request expires: {new Date(model.consent.expiresAt).toLocaleString()}</p>
      {model.kind === "verify" && !verified && model.inflight !== "inspect" && (
        model.challengeToken === null ? (
          <form className="auth-widget auth-form" onSubmit={onSubmitPassword}>
            <p>{SIGN_IN_TEXT.deviceVerify}</p>
            <label className="auth-field" htmlFor="device-password">
              <span>Password</span>
              <Input className="auth-input" id="device-password" type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} disabled={model.inflight !== null} />
            </label>
            <Button type="submit" disabled={model.inflight !== null || !password}>Continue</Button>
          </form>
        ) : (
          <form className="auth-widget auth-form" onSubmit={onSubmitOtp}>
            <label className="auth-field" htmlFor="device-otp">
              <span>Authenticator or recovery code</span>
              <Input className="auth-input" id="device-otp" autoComplete="one-time-code" value={otp} onChange={(event) => onOtp(event.target.value)} disabled={model.inflight !== null} />
            </label>
            <Button type="submit" disabled={model.inflight !== null || !otp.trim()}>Verify</Button>
            <Button type="button" disabled={model.inflight !== null} onClick={onRestart}>Start verification again</Button>
          </form>
        )
      )}
      {model.kind === "verify" && verified && model.inflight === null && <Button onClick={onRecheck}>Check again</Button>}
      {model.inflight === "inspect" && <p role="status">Checking permissions…</p>}
      {model.kind === "enroll" && (
        <>
          <p>{SIGN_IN_TEXT.deviceEnroll}</p>
          <a href="/settings" target="_blank" rel="noopener noreferrer">Settings</a>
          <Button type="button" disabled={model.inflight !== null} onClick={onRecheck}>Check again</Button>
        </>
      )}
      <div className="device-actions">
        {approve !== "hidden" && <Button disabled={approve === "busy"} onClick={() => onDecide("approve")}>{approve === "busy" ? "Approving…" : "Approve CLI access"}</Button>}
        {deny !== "hidden" && <Button disabled={deny === "busy"} variant="outline" onClick={() => onDecide("deny")}>{deny === "busy" ? "Denying…" : "Deny"}</Button>}
      </div>
    </>
  );
}

function inspectCode(model: DeviceModel): string | null {
  if (model.kind === "code" && model.inflight === "inspect") return model.draft;
  if ((model.kind === "verify" || model.kind === "enroll") && model.inflight === "inspect") return model.userCode;
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not save your decision.";
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
