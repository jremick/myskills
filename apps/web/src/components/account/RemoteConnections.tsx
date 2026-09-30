import { useEffect, useId, useState } from "react";
import { Copy, Link2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog, type ConfirmationRequest } from "@/components/ui/confirmation-dialog";
import type { OAuthConnection, OAuthConnectionClient, OAuthConnectorInfo } from "../../oauth-api.js";

/**
 * Settings row for remote MCP connections: provider setup guidance for the
 * operator-configured endpoint, and the account's active connections.
 */
export function RemoteConnections({ client }: { client?: OAuthConnectionClient }) {
  const headingId = useId();
  const [connector, setConnector] = useState<OAuthConnectorInfo | null>(null);
  const [connections, setConnections] = useState<OAuthConnection[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  useEffect(() => {
    let active = true;
    if (!client) {
      setConnector({ enabled: false, mcpUrl: null });
      return;
    }
    client.getConnector()
      .then(async (info) => {
        if (!active) return;
        setConnector(info);
        if (info.enabled) {
          const listed = await client.listConnections();
          if (active) setConnections(listed);
        }
      })
      .catch(() => {
        if (active) setMessage("Remote connection settings are not available right now.");
      });
    return () => { active = false; };
  }, [client]);

  function requestRevoke(connection: OAuthConnection) {
    setConfirmation({
      key: `revoke-connection-${connection.id}`,
      title: "Revoke this connection?",
      description: `${connection.client.name} will lose access to MySkills on its next request. Reconnect from the app to use it again.`,
      confirmLabel: "Revoke connection",
      destructive: true,
      onConfirm: async () => {
        if (!client) return;
        try {
          await client.revokeConnection(connection.id);
          setConnections((current) => (current ?? []).filter((item) => item.id !== connection.id));
        } catch {
          throw new Error("The connection could not be revoked. Try again.");
        }
      },
    });
  }

  return (
    <section aria-labelledby={headingId} className="account-row">
      <div className="account-row-intro">
        <h2 id={headingId}>Remote connections</h2>
        <p>Connect ChatGPT, Claude and other MCP hosts to MySkills. Each app starts with read access and can request additional permissions for you to approve. Your account permissions still apply.</p>
      </div>
      <div className="account-row-body remote-connections">
        {message ? (
          <p className="account-notice" data-tone="danger" role="status">{message}</p>
        ) : connector === null ? (
          <p className="account-muted" role="status">Loading remote connection settings…</p>
        ) : !connector.enabled || !connector.mcpUrl ? (
          <p className="account-muted">
            Remote MCP connections are not enabled on this MySkills server. An operator must configure a publicly reachable HTTPS MCP endpoint first; this page will then show its URL.
          </p>
        ) : (
          <>
            <div className="remote-endpoint">
              <span className="account-field-label">MCP server URL</span>
              <code>{connector.mcpUrl}</code>
              <CopyUrlButton url={connector.mcpUrl} />
            </div>
            <div className="remote-providers">
              <div>
                <h3>ChatGPT</h3>
                <p>
                  Add a custom connector (app) that uses this MCP server URL with OAuth authentication. {connector.dynamicRegistration
                    ? "ChatGPT can register itself automatically."
                    : "Use the client ID and secret from your MySkills administrator."} ChatGPT then sends you here to sign in and approve access.
                  Custom connectors depend on your ChatGPT plan and workspace settings.
                </p>
              </div>
              <div>
                <h3>Claude</h3>
                <p>
                  Open Customize, then Connectors, and choose Add custom connector. Paste this URL, {connector.dynamicRegistration
                    ? "leave the client ID and secret empty unless your administrator gave you one"
                    : "and enter the client ID and secret from your MySkills administrator"}, then connect and approve access here.
                  On Team and Enterprise plans an owner adds the connector first, then each member connects.
                </p>
              </div>
            </div>
            <p className="account-muted">
              AI apps connect from their own cloud services, so this endpoint must be publicly reachable HTTPS; a local or private address will not work.
              Never paste passwords, API keys or tokens into a chat.
            </p>
            {connections === null ? (
              <p className="account-muted" role="status">Loading connections…</p>
            ) : connections.length === 0 ? (
              <p className="account-muted">No remote connections. Connections you approve appear here.</p>
            ) : (
              <ul aria-label="Your remote connections" className="account-token-list">
                {connections.map((connection) => (
                  <li className="account-token" key={connection.id}>
                    <span className="account-cell-main">
                      <strong>{connection.client.name}</strong>
                      <small>{connection.client.registration === "configured" ? "Configured app" : "Self-registered app"} · {connection.scopes.join(", ")}</small>
                    </span>
                    <span className="account-chip">Active</span>
                    <small className="account-token-meta">
                      Connected {formatDate(connection.createdAt)} · {connection.lastUsedAt ? `Used ${formatDate(connection.lastUsedAt)}` : "Not used yet"} · Expires {formatDate(connection.expiresAt)}
                    </small>
                    <Button aria-label={`Revoke ${connection.client.name}`} className="account-danger" size="icon-sm" title={`Revoke ${connection.client.name}`} type="button" variant="outline" onClick={() => requestRevoke(connection)}>
                      <Trash2 size={15} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </section>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable.");
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }
  return (
    <>
      <Button aria-label="Copy MCP server URL" className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void copy()}>
        {status === "copied" ? <Link2 size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {status === "copied" ? "Copied" : "Copy"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {status === "copied" ? "Copied to clipboard." : status === "error" ? "Copy failed. Select and copy the URL manually." : ""}
      </span>
    </>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}
