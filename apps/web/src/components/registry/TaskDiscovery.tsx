import { useEffect, useRef, useState } from "react";
import type { TaskDiscoveryResponse } from "@myskills-app/core";
import type { RegistryClient } from "../../api.js";

export function TaskDiscovery({ client, token, skillHref }: { client: RegistryClient; token?: string; skillHref(slug: string, version: string): string }) {
  const [task, setTask] = useState("");
  const [response, setResponse] = useState<TaskDiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [client, token]);
  if (!client.discoverTask) return null;
  async function find() {
    const request = ++generation.current; setResponse(null); setError(null); setBusy(true);
    try {
      const next = await client.discoverTask!({ task, limit: 10 }, token);
      if (generation.current === request) setResponse(next);
    } catch {
      if (generation.current === request) setError("Task discovery is unavailable. Try again or use ordinary search.");
    } finally { if (generation.current === request) setBusy(false); }
  }
  return <details className="task-discovery">
    <summary>Find skills for a task</summary>
    <form onSubmit={event => { event.preventDefault(); void find(); }}>
      <label htmlFor="task-description">Task description</label>
      <textarea id="task-description" maxLength={4000} required value={task} onChange={event => { generation.current++; setTask(event.target.value); setResponse(null); setError(null); setBusy(false); }} placeholder="Describe what you need to do…" />
      <button className="button button-primary" type="submit" disabled={busy || !task.trim()}>{busy ? "Finding skills…" : "Find relevant skills"}</button>
      <p>Find approved releases by word overlap. No model calls. Review each skill before choosing how to use it.</p>
    </form>
    {error && <p role="alert">{error}</p>}
    {response && <section aria-label="Task discovery results" aria-live="polite">
      <p>Method: {response.method} · No model calls · Ordinary search available</p>
      {response.uncertainty.map(text => <p key={text}>{text}</p>)}
      {response.results.length ? <ul>{response.results.map(result => <li key={`${result.release.slug}@${result.release.version}`}>
        <a href={skillHref(result.release.slug, result.release.version)}>{result.skill.title} · {result.release.version}</a>
        <p>{result.skill.summary}</p>
        <p>{result.relevance.label.replaceAll("-", " ")} · Matched: {result.relevance.matchedTerms.join(", ")}</p>
        <code>sha256:{result.release.sha256}</code>
      </li>)}</ul> : <p>No useful word matches. Try a more specific task or use ordinary search.</p>}
    </section>}
  </details>;
}
