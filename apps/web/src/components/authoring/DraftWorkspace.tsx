import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ArchitectureNavigationGuard } from "@/components/architecture/useArchitectureNavigationGuard";
import { reviewStatusLabel, securityStatusLabel } from "@/components/registry/status-display";
import type { AuthorDraft, DraftClient, DraftFile, DraftPreview, DraftSourceInput, DraftSubmission, DraftSummary, DraftValidation } from "@/drafts-api";

const MAX_TEXT = 1_048_576;
const MAX_FILES = 500;
const MAX_ZIP = 10_485_760;
type Recovery = { registry: string; actorId: string; draftId: string; baseRevision: number; title: string; files: DraftFile[] };
type HeldFile = DraftFile & { included: boolean; error?: string };
type Notice = { text: string; error?: boolean };

const connections = new WeakMap<DraftClient, number>();
let nextConnection = 0;
/** A render-time remount clears private state before the new client can respond. */
export function DraftWorkspace(props: Omit<Parameters<typeof DraftWorkspaceState>[0], "recoveryScope"> & { credentialEpoch?: string }) {
  if (!connections.has(props.api)) connections.set(props.api, ++nextConnection);
  const epoch = connections.get(props.api)!;
  const scope = `${props.api.registryIdentity ?? window.location.origin}:${epoch}:${props.credentialEpoch ?? ""}`;
  return <DraftWorkspaceState key={`${props.actorId}:${scope}`} {...props} recoveryScope={scope} />;
}

function DraftWorkspaceState({ api, actorId, recoveryScope, url, onNavigate, onNavigationGuardChange, correctionSource, onSubmitted }: {
  api: DraftClient; actorId: string; recoveryScope: string; url: string; onNavigate: (url: string) => void;
  onNavigationGuardChange: (guard: ArchitectureNavigationGuard | null) => void;
  correctionSource: { submissionId: string; request: number } | null;
  onSubmitted: (submission: DraftSubmission) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [head, setHead] = useState<AuthorDraft | null>(null);
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [newPath, setNewPath] = useState("");
  const [renamePath, setRenamePath] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [validation, setValidation] = useState<DraftValidation | null>(null);
  const [receipt, setReceipt] = useState<DraftSubmission | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [conflict, setConflict] = useState<AuthorDraft | null>(null);
  const [previewText, setPreviewText] = useState(false);
  const [held, setHeld] = useState<HeldFile[]>([]);
  const [folderRoot, setFolderRoot] = useState<string | null>(null);
  const [removeRoot, setRemoveRoot] = useState(false);
  const [importPreview, setImportPreview] = useState<DraftPreview | null>(null);
  const [history, setHistory] = useState<DraftSummary[] | null>(null);
  const [comparison, setComparison] = useState<AuthorDraft | null>(null);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [changeKind, setChangeKind] = useState<"fix" | "feature" | "breaking" | "security" | "maintenance">("fix");
  const generation = useRef(0);
  const comparisonGeneration = useRef(0);
  const importGeneration = useRef(0);
  const storageWarningShown = useRef(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const focusAfterCreate = useRef(false);
  const headRef = useRef(head);
  headRef.current = head;
  const dirty = Boolean(head && (head.title !== title || JSON.stringify(head.files) !== JSON.stringify(files)));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selected = files.find((file) => file.path === selectedPath);

  useEffect(() => {
    if (!focusAfterCreate.current || busy || !head) return;
    focusAfterCreate.current = false;
    workspaceRef.current?.querySelector<HTMLInputElement>('input[aria-label="Draft title"]')?.focus({ preventScroll: true });
    workspaceRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [busy, head]);

  useEffect(() => () => { generation.current += 1; comparisonGeneration.current += 1; importGeneration.current += 1; }, []);

  const refreshList = useCallback(async () => {
    const ticket = generation.current;
    try {
      const result = await api.list();
      if (ticket === generation.current) { setDrafts(result.drafts); setListError(null); }
    } catch (error) {
      if (ticket === generation.current) setListError(message(error));
    }
  }, [api]);
  useEffect(() => { void refreshList(); }, [refreshList]);

  function forgetRecovery(draftId: string) {
    try { sessionStorage.removeItem(storageKey(recoveryScope, actorId, draftId)); } catch { /* Saving on the server remains authoritative. */ }
    setRecovery(null);
  }

  function acceptHead(draft: AuthorDraft, checkRecovery = true) {
    comparisonGeneration.current += 1; importGeneration.current += 1;
    setHead(draft); setTitle(draft.title); setFiles(draft.files);
    setSelectedPath((previous) => draft.files.some((file) => file.path === previous) ? previous : draft.files[0]?.path ?? "");
    setValidation(null); setReceipt(null); setConflict(null); setHistory(null); setComparison(null);
    setHeld([]); setImportPreview(null); setFolderRoot(null); setRemoveRoot(false);
    setRecovery(checkRecovery ? readRecovery(recoveryScope, actorId, draft.id) : null);
    setCreating(false);
  }

  const guard = useCallback<ArchitectureNavigationGuard>((action, destination) => {
    if (!dirtyRef.current) return true;
    if (destination) {
      const next = new URL(destination, window.location.href);
      if (next.origin === window.location.origin && next.pathname === "/submit" && next.searchParams.get("draft") === headRef.current?.id) return true;
    }
    return window.confirm(`You have unsaved package edits. Leave them in this tab's recovery storage and ${action}?`);
  }, []);

  useEffect(() => {
    onNavigationGuardChange(guard);
    return () => onNavigationGuardChange(null);
  }, [guard, onNavigationGuardChange]);

  useEffect(() => {
    if (!dirty || !head) return;
    const item: Recovery = { registry: recoveryScope, actorId, draftId: head.id, baseRevision: head.revision, title, files };
    try { sessionStorage.setItem(storageKey(recoveryScope, actorId, head.id), JSON.stringify(item)); }
    catch {
      if (!storageWarningShown.current) { setNotice({ text: "This tab cannot store recovery data. Save your draft before leaving.", error: true }); storageWarningShown.current = true; }
    }
  }, [actorId, recoveryScope, dirty, files, head, title]);

  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (!guard("navigate away", anchor.href)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty, guard]);

  async function loadDraft(draftId: string) {
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const result = await api.get(draftId);
      if (ticket === generation.current) { acceptHead(result.draft); void refreshList(); }
    } catch (error) {
      if (ticket === generation.current) { setHead(null); setFiles([]); setNotice({ text: message(error), error: true }); }
    } finally { if (ticket === generation.current) setBusy(false); }
  }

  useEffect(() => {
    const selectedId = new URL(url, window.location.origin).searchParams.get("draft");
    if (selectedId && selectedId !== headRef.current?.id) void loadDraft(selectedId);
    // Route changes are guarded by the app; content edits do not refetch a head.
  }, [api, url]);

  function navigateDraft(draftId: string) {
    const next = new URL("/submit", window.location.origin);
    next.searchParams.set("draft", draftId);
    onNavigate(`${next.pathname}${next.search}`);
  }

  function canReplace() { return !dirtyRef.current || window.confirm("Replace these unsaved edits? They remain available in this tab's recovery storage until you save or discard them."); }

  async function createDraft(input: { title: string; files: DraftFile[] } | { source: DraftSourceInput }) {
    if (!canReplace() || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const result = await api.create(input);
      if (ticket !== generation.current) return;
      focusAfterCreate.current = true;
      acceptHead(result.draft); navigateDraft(result.draft.id);
      setNotice({ text: "Saved revision 1." });
      void refreshList();
    } catch (error) { if (ticket === generation.current) setNotice({ text: message(error), error: true }); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  useEffect(() => {
    if (correctionSource) void createDraft({ source: { kind: "submission", submissionId: correctionSource.submissionId } });
  }, [correctionSource]);

  async function runSaved(action: "save" | "validate" | "submit", restored?: AuthorDraft) {
    if (!head || busy || conflict || recovery || (action !== "save" && dirty)) return;
    if (restored && !canReplace()) return;
    const savedHead = head;
    const ticket = generation.current;
    setBusy(true); setNotice(null);
    try {
      if (action === "save") {
        const next = await api.update(savedHead.id, { expectedRevision: savedHead.revision, title: restored?.title ?? title, files: restored?.files ?? files });
        if (ticket !== generation.current) return;
        forgetRecovery(savedHead.id); acceptHead(next.draft, false);
        setNotice({ text: `Saved revision ${next.draft.revision}.` }); void refreshList();
      } else if (action === "validate") {
        const result = await api.validate(savedHead.id, savedHead.revision);
        if (ticket === generation.current) setValidation(result.validation);
      } else {
        const result = await api.submit(savedHead.id, savedHead.revision, releaseNotes.trim() ? { releaseNotes, changeKind } : undefined);
        if (ticket !== generation.current) return;
        acceptHead(result.draft, false); setReceipt(result.submission);
        setNotice({ text: `Submitted ${result.submission.slug}@${result.submission.version}.` });
        void refreshList();
        try { await onSubmitted(result.submission); }
        catch { /* The immutable submission receipt remains valid. */ }
        try {
          const refreshed = await api.history(savedHead.id);
          if (ticket === generation.current) setHistory(refreshed.revisions);
        } catch { /* Receipt remains valid if the separate history refresh fails. */ }
      }
    } catch (error) {
      if (ticket !== generation.current) return;
      if (errorCode(error) === "DRAFT_REVISION_CONFLICT") {
        try {
          const latest = await api.get(savedHead.id);
          if (ticket === generation.current) { setConflict(latest.draft); setNotice({ text: `A newer revision is saved (revision ${latest.draft.revision}). Your edits remain here. Compare them before choosing the saved revision or saving your edits on top.`, error: true }); }
        } catch { if (ticket === generation.current) setNotice({ text: "A newer revision is saved. Reload the draft to resolve the conflict; your edits remain in this tab's recovery storage.", error: true }); }
      } else setNotice({ text: message(error), error: true });
    } finally { if (ticket === generation.current) setBusy(false); }
  }

  function editFiles(next: DraftFile[]) { setFiles(next); setValidation(null); setReceipt(null); }
  function setContent(content: string) { editFiles(files.map((file) => file.path === selectedPath ? { ...file, content } : file)); }

  function addFile() {
    const path = newPath.trim();
    const problem = pathProblem(path, files);
    if (problem) { setNotice({ text: problem, error: true }); return; }
    if (files.length >= MAX_FILES) { setNotice({ text: "A package can contain at most 500 files.", error: true }); return; }
    editFiles([...files, { path, content: "" }]); setSelectedPath(path); setNewPath("");
  }

  function renameFile() {
    const path = renamePath.trim();
    const problem = pathProblem(path, files.filter((file) => file.path !== selectedPath));
    if (problem) { setNotice({ text: problem, error: true }); return; }
    editFiles(files.map((file) => file.path === selectedPath ? { ...file, path } : file)); setSelectedPath(path); setRenamePath("");
  }

  function syncMetadata() {
    if (!manifest || typeof manifest.name !== "string" || typeof manifest.summary !== "string") {
      setNotice({ text: "Add a skill name and summary to the manifest first.", error: true }); return;
    }
    try {
      editFiles(files.map((file) => file.path === "SKILL.md" ? { ...file, content: syncFrontmatter(file.content, manifest.name as string, manifest.summary as string) } : file));
    } catch { setNotice({ text: "This SKILL.md metadata uses multiline YAML. Update its name and description in the text editor to retain that structure.", error: true }); }
  }

  async function readHeldFiles(selectedFiles: FileList | null) {
    if (!selectedFiles?.length) return;
    const ticket = ++importGeneration.current;
    setImportPreview(null); setHeld([]); setNotice(null); setRemoveRoot(false);
    const chosen = Array.from(selectedFiles);
    if (chosen.length > MAX_FILES) { setNotice({ text: "Choose at most 500 files.", error: true }); return; }
    if (chosen.reduce((sum, file) => sum + file.size, 0) > MAX_TEXT) { setNotice({ text: "Selected text exceeds 1 MiB. Choose a smaller package.", error: true }); return; }
    try {
      const results: HeldFile[] = [];
      for (const file of chosen) {
        const path = file.webkitRelativePath || file.name;
        try {
          const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
          if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(content)) throw new Error("Binary or control-character content is excluded.");
          results.push({ path, content, included: true });
        } catch { results.push({ path, content: "", included: false, error: "Invalid UTF-8 or binary content; this file cannot be imported." }); }
      }
      if (ticket !== importGeneration.current) return;
      setHeld(results);
      const roots = new Set(chosen.filter((file) => file.webkitRelativePath).map((file) => file.webkitRelativePath.split("/")[0]));
      setFolderRoot(roots.size === 1 && chosen.every((file) => file.webkitRelativePath) ? [...roots][0]! : null);
    } catch { if (ticket === importGeneration.current) setNotice({ text: "Selected files could not be read. Choose them again.", error: true }); }
  }

  async function previewImport() {
    if (busy) return;
    const ticket = generation.current;
    setBusy(true); setNotice(null);
    try {
      const included = held.filter((file) => file.included).map(({ path, content }) => ({ path: removeRoot && folderRoot ? path.slice(folderRoot.length + 1) : path, content }));
      if (!included.length) throw new Error("Select at least one readable text file.");
      const result = await api.preview({ files: included });
      if (ticket === generation.current) setImportPreview(result.preview);
    } catch (error) { if (ticket === generation.current) setNotice({ text: message(error), error: true }); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  async function previewZip(file?: File) {
    if (!file || busy) return;
    setHeld([]); setImportPreview(null); setFolderRoot(null); setRemoveRoot(false);
    const ticket = generation.current;
    setBusy(true); setNotice(null);
    try {
      if (!file.name.toLowerCase().endsWith(".zip") || !file.size || file.size > MAX_ZIP) throw new Error("Choose a nonempty .zip archive of at most 10 MiB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      const result = await api.preview({ archive: { filename: file.name, contentBase64: btoa(binary) } });
      if (ticket === generation.current) setImportPreview(result.preview);
    } catch (error) { if (ticket === generation.current) setNotice({ text: message(error), error: true }); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  async function applyImport() {
    if (!importPreview || busy) return;
    if (head) {
      if (!canReplace()) return;
      editFiles(importPreview.files); setSelectedPath(importPreview.files[0]?.path ?? "");
      setImportPreview(null); setHeld([]); setNotice({ text: "Imported files are held in this editor. Save explicitly to retain them on the server." });
    } else {
      const importedTitle = typeof importPreview.validation.manifest?.title === "string" ? importPreview.validation.manifest.title : "Imported package";
      await createDraft({ title: importedTitle.slice(0, 120), files: importPreview.files });
    }
  }

  async function openHistory() {
    if (!head || busy) return;
    const ticket = generation.current;
    setBusy(true);
    try {
      const result = await api.history(head.id);
      if (ticket === generation.current) { setHistory(result.revisions); setComparison(null); }
    } catch (error) { if (ticket === generation.current) setNotice({ text: message(error), error: true }); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  async function compareRevision(revision: number) {
    if (!head) return;
    const ticket = ++comparisonGeneration.current;
    const draftId = head.id;
    try {
      const result = await api.revision(draftId, revision);
      if (ticket === comparisonGeneration.current && headRef.current?.id === draftId) setComparison(result.draft);
    } catch (error) { if (ticket === comparisonGeneration.current) setNotice({ text: message(error), error: true }); }
  }

  const manifestFile = files.find((file) => file.path === "skill.json" || file.path === "skill.manifest.json");
  const manifest = parseObject(manifestFile?.content);
  const textBytes = files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0);
  const heldChanges = importPreview ?? null;

  return <section aria-label="Private package drafts" className="author-drafts" ref={workspaceRef} aria-busy={busy}>
    <div className="draft-heading"><div><h2>Private package drafts</h2><p>Edit a text package, save a revision, then submit it for review.</p></div><Button disabled={busy} size="sm" variant="outline" onClick={() => { setCreating(!creating); setNotice(null); }}>New draft</Button></div>
    <div className="draft-toolbar"><label>Saved draft<select aria-label="Saved draft" disabled={busy} value={head?.id ?? ""} onChange={(event) => { const id = event.target.value; if (id && canReplace()) { navigateDraft(id); void loadDraft(id); } }}><option value="">Choose a private draft</option>{drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title} · revision {draft.revision}</option>)}</select></label><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refreshList()}>Refresh drafts</Button><a href="/libraries">Import from GitHub in Libraries</a></div>
    {listError && <p role="alert" className="author-status" data-tone="danger">{listError}</p>}
    {creating && <form className="draft-create" onSubmit={(event) => { event.preventDefault(); const name = newName.trim(); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { setNotice({ text: "Use lowercase letters, numbers and single hyphens for the skill name.", error: true }); return; } void createDraft({ title: name, files: templateFiles(name) }); }}><label>New skill name<input aria-label="New skill name" autoFocus maxLength={120} disabled={busy} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="release-notes-helper" /></label><p>Starts at 0.1.0 with private visibility, UNLICENSED, and Codex support.</p><Button size="sm" disabled={busy || !newName.trim()} type="submit">Create draft</Button></form>}
    {notice && <p className="author-status" data-tone={notice.error ? "danger" : undefined} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {recovery && head && <div className="draft-resolution" role="region" aria-label="Unsaved edit recovery"><h3>Unsaved edits are available</h3><p>Recovery was based on revision {recovery.baseRevision}. The server is at revision {head.revision}.{recovery.baseRevision !== head.revision && " The saved draft changed. Compare the recovered edits before saving them as a new revision."}</p><Button size="sm" disabled={busy} onClick={() => { setTitle(recovery.title); setFiles(recovery.files); setSelectedPath(recovery.files[0]?.path ?? ""); setRecovery(null); setNotice({ text: "Recovered edits are held locally. Save explicitly to create a new revision." }); }}>Recover unsaved edits</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => forgetRecovery(head.id)}>Discard recovery</Button><FileComparison older={recovery.files} newer={head.files} olderLabel="Recovered edits" newerLabel="Saved files" /></div>}
    {conflict && head && <div className="draft-resolution" role="region" aria-label="Draft save conflict"><FileComparison older={files} newer={conflict.files} olderLabel="Your held edits" newerLabel={`Saved revision ${conflict.revision}`} /><p>Held title: {title}. Saved title: {conflict.title}.</p><Button size="sm" disabled={busy} onClick={() => { forgetRecovery(head.id); acceptHead(conflict, false); setNotice({ text: `Loaded revision ${conflict.revision}.` }); }}>Load latest saved revision</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { setHead(conflict); setConflict(null); setNotice({ text: "Your edits now use the latest revision as their base. Save to create a new revision." }); }}>Keep edits on latest revision</Button></div>}
    <details className="draft-import" open={held.length > 0 || Boolean(importPreview)}><summary>Import held folder, text files or ZIP</summary><p>Select the package files you want to retain. Imports replace the current editor files after your review.</p><div className="draft-import-controls"><label>Text files<input aria-label="Text files" type="file" multiple disabled={busy} onChange={(event) => { void readHeldFiles(event.target.files); event.target.value = ""; }} /></label><label>Package folder<input aria-label="Package folder" type="file" multiple disabled={busy} {...{ webkitdirectory: "", directory: "" }} onChange={(event) => { void readHeldFiles(event.target.files); event.target.value = ""; }} /></label><label>ZIP preview<input aria-label="ZIP preview" type="file" accept=".zip" disabled={busy} onChange={(event) => { void previewZip(event.target.files?.[0]); event.target.value = ""; }} /></label></div>
      {folderRoot && <label className="draft-checkbox"><input type="checkbox" checked={removeRoot} disabled={busy} onChange={(event) => { setRemoveRoot(event.target.checked); setImportPreview(null); }} />Remove selected folder root “{folderRoot}/” from package paths</label>}
      {held.length > 0 && <><ul className="draft-import-files" aria-label="Selected file inclusion">{held.map((file, index) => <li key={`${file.path}:${index}`}><label><input type="checkbox" checked={file.included} disabled={busy || Boolean(file.error)} onChange={(event) => { setHeld(held.map((item, i) => i === index ? { ...item, included: event.target.checked } : item)); setImportPreview(null); }} /><code>{removeRoot && folderRoot ? file.path.slice(folderRoot.length + 1) : file.path}</code><span>{file.included ? "Included" : "Excluded"}{file.error ? ` — ${file.error}` : ""}</span></label></li>)}</ul><Button size="sm" disabled={busy} onClick={() => void previewImport()}>Preview import</Button></>}
      {heldChanges && <div className="draft-import-preview"><h3>Import preview</h3><p>{heldChanges.fileCount} files · {heldChanges.textBytes.toLocaleString()} bytes. No files are saved until you choose to use them.</p><ul>{heldChanges.files.map((file) => <li key={file.path}><code>{file.path}</code></li>)}</ul><ValidationReport validation={heldChanges.validation} /><Button size="sm" disabled={busy} onClick={() => void applyImport()}>Use imported files</Button><Button size="sm" disabled={busy} variant="ghost" onClick={() => { setImportPreview(null); setHeld([]); }}>Discard import</Button></div>}
    </details>
    {head && <>
      <div className="draft-head"><label>Draft title<input aria-label="Draft title" maxLength={120} disabled={busy || Boolean(recovery)} value={title} onChange={(event) => setTitle(event.target.value)} /></label><span>Revision {head.revision} · {dirty ? "Unsaved edits" : "Saved"} · {files.length} files · {textBytes.toLocaleString()} bytes</span></div>
      {head.source && <p className="draft-source">Source: {head.source.kind} · <code>{head.source.slug}@{head.source.version}</code> · <code>{head.source.artifactSha256}</code>. Retain its license and attribution. Use a new slug when you do not own this skill, and a new version for a correction.</p>}
      <div className="draft-editor">
        <aside className="draft-file-tree"><label>Draft file<select aria-label="Draft file" disabled={busy || Boolean(recovery)} value={selectedPath} onChange={(event) => { setSelectedPath(event.target.value); setPreviewText(false); setRenamePath(""); }}>{files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label><ul>{files.map((file) => <li key={file.path}><button type="button" disabled={busy || Boolean(recovery)} aria-current={file.path === selectedPath ? "true" : undefined} onClick={() => { setSelectedPath(file.path); setPreviewText(false); }}><code>{file.path}</code></button></li>)}</ul><label>New file path<input aria-label="New file path" disabled={busy || Boolean(recovery)} value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="references/checklist.md" /></label><Button size="sm" variant="outline" disabled={busy || Boolean(recovery) || !newPath.trim()} onClick={addFile}>Add file</Button><label>Rename selected file<input aria-label="Rename selected file" disabled={busy || Boolean(recovery)} value={renamePath} onChange={(event) => setRenamePath(event.target.value)} /></label><Button size="sm" variant="outline" disabled={busy || Boolean(recovery) || !selected || !renamePath.trim()} onClick={renameFile}>Rename file</Button><Button size="sm" variant="ghost" disabled={busy || Boolean(recovery) || !selected} onClick={() => { if (!selected || !window.confirm(`Remove ${selected.path} from these held edits? Saved snapshots remain available.`)) return; const next = files.filter((file) => file.path !== selected.path); editFiles(next); setSelectedPath(next[0]?.path ?? ""); }}>Remove file</Button></aside>
        <div className="draft-text-editor"><div className="draft-file-heading"><strong>{selected?.path ?? "Choose a file"}</strong><Button size="sm" variant="ghost" disabled={!selected} onClick={() => setPreviewText(!previewText)}>{previewText ? "Edit text" : "Preview text"}</Button></div>{selected && (previewText ? <pre aria-label="Safe file preview" className="draft-safe-preview">{selected.content}</pre> : <textarea aria-label="File contents" spellCheck={false} disabled={busy || Boolean(recovery)} value={selected.content} onChange={(event) => setContent(event.target.value)} />)}<p className="draft-editor-note">Plain text only. Package content is never executed. Editing a file uses the text and line endings entered by your browser; untouched imports retain their exact content.</p></div>
      </div>
      <details className="draft-assistance"><summary>Manifest and SKILL.md metadata</summary>{manifest && manifestFile ? <><div className="draft-manifest-fields">{["name", "title", "summary", "version", "license"].map((field) => <label key={field}>{field === "name" ? "Skill name" : field[0]!.toUpperCase() + field.slice(1)}<input aria-label={`Manifest ${field}`} disabled={busy || Boolean(recovery)} value={typeof manifest[field] === "string" ? manifest[field] as string : ""} onChange={(event) => editFiles(files.map((file) => file.path === manifestFile.path ? { ...file, content: `${JSON.stringify({ ...manifest, [field]: event.target.value }, null, 2)}\n` } : file))} /></label>)}<label>Visibility<select aria-label="Manifest visibility" disabled={busy || Boolean(recovery)} value={typeof manifest.visibility === "string" ? manifest.visibility : ""} onChange={(event) => editFiles(files.map((file) => file.path === manifestFile.path ? { ...file, content: `${JSON.stringify({ ...manifest, visibility: event.target.value }, null, 2)}\n` } : file))}><option value="" disabled>Choose visibility</option><option value="private">Private</option><option value="team">Team</option><option value="public">Public</option></select></label></div><p>Only the field you change is updated. Other manifest fields and license values are retained.</p><Button size="sm" variant="outline" disabled={busy || Boolean(recovery) || !files.some((file) => file.path === "SKILL.md")} onClick={syncMetadata}>Sync SKILL.md metadata</Button></> : <p>The manifest is incomplete. Edit skill.json as text, then use these fields when it contains a JSON object.</p>}</details>
      <div className="draft-actions"><Button size="sm" disabled={busy || Boolean(recovery) || Boolean(conflict) || !title.trim() || !dirty || textBytes > MAX_TEXT} onClick={() => void runSaved("save")}>Save draft</Button><Button size="sm" variant="outline" disabled={busy || dirty || Boolean(recovery) || Boolean(conflict)} onClick={() => void runSaved("validate")}>Validate saved draft</Button><Button size="sm" variant="outline" disabled={busy || dirty || Boolean(recovery) || Boolean(conflict)} onClick={() => void runSaved("submit")}>Submit saved revision</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void openHistory()}>Saved history</Button></div>
      {textBytes > MAX_TEXT && <p role="alert">Package text exceeds 1 MiB. Remove or shorten files before saving.</p>}
      {dirty && <p className="draft-editor-note">Save your held edits before validating or submitting. Your private draft history retains every saved snapshot.</p>}
      <details className="draft-release-notes"><summary>Release notes</summary><label>Release notes<textarea aria-label="Draft release notes" disabled={busy} value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} /></label><label>Change kind<select aria-label="Draft change kind" disabled={busy} value={changeKind} onChange={(event) => setChangeKind(event.target.value as typeof changeKind)}><option value="fix">Fix</option><option value="feature">Feature</option><option value="breaking">Breaking change</option><option value="security">Security fix</option><option value="maintenance">Maintenance</option></select></label></details>
      {validation && <ValidationReport validation={validation} />}
      {receipt && <div className="draft-receipt" role="status"><h3>Submitted {receipt.slug}@{receipt.version}</h3><p>{reviewStatusLabel(receipt.reviewStatus).label} · {securityStatusLabel(receipt.securityStatus).label} · Scan: {receipt.scan.status}</p>{receipt.scan.status !== "passed" && <p>Scan completion and review are separate steps. Check the submitted package history below for current results.</p>}<code>{receipt.artifactSha256}</code>{receipt.scan.findings.length > 0 && <ul>{receipt.scan.findings.map((finding, index) => <li key={index}>{finding.severity}: {finding.message}{finding.path ? ` (${finding.path})` : ""}</li>)}</ul>}</div>}
      {head.submission && !receipt && <p className="draft-editor-note">This saved revision is linked to {head.submission.slug}@{head.submission.version}. A retry returns the same submission. Save a new revision with a new package version for further work.</p>}
      {history && <section className="draft-history" aria-label="Saved draft history"><h3>Saved history</h3><p>Restoring saves a new revision. Earlier files and submission receipts remain unchanged.</p><label>Compare saved revision<select aria-label="Compare saved revision" disabled={busy} value={comparison?.revision ?? ""} onChange={(event) => { const revision = Number(event.target.value); if (revision > 0) void compareRevision(revision); else { comparisonGeneration.current += 1; setComparison(null); } }}><option value="">Choose a revision</option>{history.map((item) => <option key={item.revision} value={item.revision}>Revision {item.revision} · {item.title}{item.submission ? ` · submitted ${item.submission.version}` : ""}</option>)}</select></label>{comparison && <><FileComparison older={comparison.files} newer={files} olderLabel={`Revision ${comparison.revision}`} newerLabel={dirty ? "Held edits" : `Revision ${head.revision}`} /><Button size="sm" variant="outline" disabled={busy || Boolean(recovery) || Boolean(conflict)} onClick={() => void runSaved("save", comparison)}>Restore as new revision</Button></>}</section>}
    </>}
    {!head && !busy && !creating && <p className="draft-empty">Start a private draft or import held package files. Saved workspaces are visible only to your account.</p>}
  </section>;
}

export function ForkReleaseDraft({ api, slug, version, platform }: { api: DraftClient; slug: string; version: string; platform: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setBusy(false); setError(null); return () => { generation.current += 1; }; }, [api, slug, version, platform]);
  return <div className="draft-fork"><Button size="sm" variant="outline" disabled={busy} onClick={async () => { const ticket = generation.current; setBusy(true); setError(null); try { const result = await api.create({ source: { kind: "release", slug, version, platform } }); if (ticket === generation.current) window.location.assign(`/submit?draft=${encodeURIComponent(result.draft.id)}`); } catch (cause) { if (ticket === generation.current) setError(message(cause)); } finally { if (ticket === generation.current) setBusy(false); } }}>Fork exact release into private draft</Button>{error && <p role="alert">{error}</p>}</div>;
}

function ValidationReport({ validation }: { validation: DraftValidation }) {
  return <section className="draft-validation" aria-label="Draft package validation"><h3>{validation.valid ? "Package is valid" : "Package needs changes"}</h3><p>Validation describes these saved or previewed files. It does not approve or publish a release.</p>{validation.issues.length > 0 && <ul>{validation.issues.map((issue, index) => <li key={index}><strong>{issue.code}</strong>{issue.path ? <code>{issue.path}</code> : null}<span>{issue.message}</span></li>)}</ul>}{validation.findings.length > 0 ? <ul>{validation.findings.map((finding, index) => <li key={index}><strong>{finding.severity} · {finding.category}</strong>{finding.path ? <code>{finding.path}</code> : null}<span>{finding.message}</span></li>)}</ul> : <p>No scanner findings in this validation result.</p>}</section>;
}

function FileComparison({ older, newer, olderLabel, newerLabel }: { older: DraftFile[]; newer: DraftFile[]; olderLabel: string; newerLabel: string }) {
  const previous = new Map(older.map((file) => [file.path, file.content]));
  const current = new Map(newer.map((file) => [file.path, file.content]));
  const changes = [...new Set([...previous.keys(), ...current.keys()])].sort().filter((path) => previous.get(path) !== current.get(path));
  return <div className="draft-comparison"><p>{changes.length ? `${changes.length} changed files` : "No file content changes"}</p>{changes.map((path) => <details key={path}><summary><code>{path}</code> · {!previous.has(path) ? "Added" : !current.has(path) ? "Removed" : "Modified"}</summary><div className="draft-diff"><div><strong>{olderLabel}</strong><pre>{previous.get(path) ?? "File absent"}</pre></div><div><strong>{newerLabel}</strong><pre>{current.get(path) ?? "File absent"}</pre></div></div></details>)}</div>;
}

function templateFiles(name: string): DraftFile[] {
  const summary = "Describe what this skill does.";
  return [{ path: "skill.json", content: `${JSON.stringify({ name, title: name, summary, version: "0.1.0", license: "UNLICENSED", visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: [] }, null, 2)}\n` }, { path: "SKILL.md", content: ["---", `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(summary)}`, "---", "", "# Skill instructions", "", "Add the instructions for this skill here.", ""].join("\n") }];
}
function syncFrontmatter(content: string, name: string, summary: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const fields = [`name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(summary)}`];
  if (!match) return `---\n${fields.join("\n")}\n---\n\n${content}`;
  let body = match[1]!;
  const lines = body.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const field = /^(?:name|description):\s*(.*)$/u.exec(line);
    if (!field) continue;
    const value = field[1]!.trim();
    if (/^[|>]/u.test(value) || (!value && /^\s+\S/u.test(lines[index + 1] ?? "")) || ((value.startsWith('"') || value.startsWith("'")) && value.at(-1) !== value[0])) throw new Error("Multiline metadata requires text editing.");
  }
  for (const field of fields) { const key = field.split(":")[0]!; const expression = new RegExp(`^${key}:[^\\r\\n]*`, "m"); body = expression.test(body) ? body.replace(expression, () => field) : `${body}\n${field}`; }
  return `${content.startsWith("\uFEFF") ? "\uFEFF" : ""}---\n${body}\n---\n${content.slice(match[0].length)}`;
}
function parseObject(content?: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(content ?? ""); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function pathProblem(path: string, files: DraftFile[]): string | null {
  if (!path || path.length > 1_024 || path.startsWith("/") || /[\\:\u0000-\u001F\u007F]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return "Use a relative package path with no traversal, control characters or backslashes.";
  if (files.some((file) => file.path.toLocaleLowerCase("en-US") === path.toLocaleLowerCase("en-US"))) return "A file with this path already exists. Choose a distinct portable path.";
  return null;
}
function storageKey(registry: string, actorId: string, draftId: string) { return `myskills:draft-recovery:${encodeURIComponent(registry)}:${actorId}:${draftId}`; }
function readRecovery(recoveryScope: string, actorId: string, draftId: string): Recovery | null {
  try {
    const raw = sessionStorage.getItem(storageKey(recoveryScope, actorId, draftId));
    if (!raw || raw.length > MAX_TEXT * 6) return null;
    const value = JSON.parse(raw) as Recovery;
    if (value.registry !== recoveryScope || value.actorId !== actorId || value.draftId !== draftId || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 1 || typeof value.title !== "string" || value.title.length > 120 || !Array.isArray(value.files) || value.files.length > MAX_FILES || value.files.some((file) => !file || typeof file.path !== "string" || typeof file.content !== "string")) return null;
    return value;
  } catch { return null; }
}
function errorCode(error: unknown): string { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function message(error: unknown) { return error instanceof Error ? error.message : "The draft operation failed. Try again."; }
