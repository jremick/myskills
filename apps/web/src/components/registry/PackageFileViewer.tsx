import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { safeErrorMessage, type SkillPackageBundle } from "../../api.js";

const MAX_VISIBLE_FILES = 1_000;
const MAX_VISIBLE_CHARACTERS = 128_000;

export function PackageFileViewer({ resourceKey, loadBundle, label = "Inspect package files" }: {
  resourceKey: string;
  loadBundle: () => Promise<SkillPackageBundle>;
  label?: string;
}) {
  const [bundle, setBundle] = useState<SkillPackageBundle | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    setBundle(null);
    setSelectedPath("");
    setState("idle");
    setMessage(null);
    return () => { epoch.current += 1; };
  }, [resourceKey]);

  async function inspect() {
    const requestEpoch = ++epoch.current;
    setState("loading");
    setMessage(null);
    try {
      const result = await loadBundle();
      if (requestEpoch !== epoch.current) return;
      if (!result || !Array.isArray(result.files) || result.files.length > MAX_VISIBLE_FILES || result.files.some((file) => typeof file.path !== "string" || file.path.length > 1_024 || typeof file.content !== "string")) {
        throw new Error("This package cannot be displayed safely.");
      }
      const files = [...result.files].sort((left, right) => left.path.localeCompare(right.path));
      setBundle({ files });
      setSelectedPath(files.find((file) => /(^|\/)SKILL\.md$/i.test(file.path))?.path ?? files.find((file) => /(^|\/)README\.md$/i.test(file.path))?.path ?? files[0]?.path ?? "");
      setState("ready");
    } catch (error) {
      if (requestEpoch !== epoch.current) return;
      setBundle(null);
      setState("error");
      setMessage(safeErrorMessage(error));
    }
  }

  const selected = bundle?.files.find((file) => file.path === selectedPath);
  const binary = selected?.content.includes("\0") ?? false;
  return <section className="package-file-viewer control-plane-section" aria-label="Package files">
    <h2>Package contents</h2>
    <p className="control-plane-muted">Read the instructions, prerequisites, examples, and supporting files before using this package. Files are displayed as text; nothing is executed.</p>
    {state !== "ready" && <Button type="button" size="sm" variant="outline" disabled={state === "loading"} onClick={() => void inspect()}>{state === "loading" ? "Loading package files…" : label}</Button>}
    {message && <p role="alert">{message}</p>}
    {state === "ready" && bundle && <>
      {bundle.files.length === 0 ? <p role="status">This package contains no readable files.</p> : <>
        <label className="control-plane-form"><span>Package file</span><select aria-label="Package file" value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}>{bundle.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
        <p className="control-plane-muted">{bundle.files.length} files · {selected?.content.length.toLocaleString() ?? 0} characters in this file</p>
        {binary ? <p role="status">Binary content is not displayed. Inspect the downloaded package using an appropriate local tool.</p> : <pre className="package-file-content" tabIndex={0} aria-label={`Contents of ${selectedPath}`}><code>{selected?.content.slice(0, MAX_VISIBLE_CHARACTERS)}</code></pre>}
        {!binary && selected && selected.content.length > MAX_VISIBLE_CHARACTERS && <p role="status">Preview limited to the first {MAX_VISIBLE_CHARACTERS.toLocaleString()} characters. Export the package to inspect the complete file.</p>}
      </>}
    </>}
  </section>;
}
