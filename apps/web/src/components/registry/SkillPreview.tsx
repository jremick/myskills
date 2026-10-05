import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { safeErrorMessage, type SkillPackageBundle } from "../../api.js";

const MAX_PREVIEW_CHARACTERS = 128_000;
class PreviewValidationError extends Error {}

/** Mount with a key containing skill, exact release, platform and viewer identity. */
export function SkillPreview({ title, version, platform, loadBundle }: {
  title: string;
  version: string;
  platform: string;
  loadBundle: () => Promise<SkillPackageBundle>;
}) {
  const [request, setRequest] = useState<Promise<SkillPackageBundle> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  function open() {
    if (opening.current) return;
    opening.current = true;
    setRequest(Promise.resolve().then(loadBundle));
  }
  function close() {
    opening.current = false;
    setRequest(null);
  }
  return <>
    <Button ref={trigger} type="button" size="sm" variant="outline" aria-haspopup="dialog" onClick={open}>
      <BookOpen size={16} aria-hidden="true" /> View Skill
    </Button>
    {request && <SkillPreviewDialog title={title} version={version} platform={platform} initialRequest={request} loadBundle={loadBundle} onClose={close} returnFocus={() => trigger.current?.focus()} />}
  </>;
}

function SkillPreviewDialog({ title, version, platform, initialRequest, loadBundle, onClose, returnFocus }: {
  title: string;
  version: string;
  platform: string;
  initialRequest: Promise<SkillPackageBundle>;
  loadBundle: () => Promise<SkillPackageBundle>;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(returnFocus);
  restoreFocus.current = returnFocus;
  const [request, setRequest] = useState(initialRequest);
  const [result, setResult] = useState<{ state: "loading" } | { state: "ready"; content: string | null } | { state: "error"; message: string }>({ state: "loading" });

  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    heading.current?.focus();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      restoreFocus.current();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    async function load() {
      try {
        const bundle = await request;
        if (cancelled) return;
        if (!bundle || !Array.isArray(bundle.files) || bundle.files.length > 1_000 || bundle.files.some(file => !file || typeof file.path !== "string" || typeof file.content !== "string")) {
          throw new PreviewValidationError("This package cannot be displayed safely.");
        }
        // Only the canonical instructions, never a nested skill or README fallback.
        const files = bundle.files.filter(file => file.path === "SKILL.md");
        if (files.length > 1) throw new PreviewValidationError("This package contains more than one root SKILL.md file.");
        const content = files[0]?.content ?? null;
        if (content?.includes("\0")) throw new PreviewValidationError("SKILL.md contains binary content and cannot be previewed.");
        if (content && content.length > MAX_PREVIEW_CHARACTERS) throw new PreviewValidationError("SKILL.md is too large to preview. Export this release to read the complete file.");
        setResult({ state: "ready", content });
      } catch (error) {
        if (!cancelled) setResult({ state: "error", message: error instanceof PreviewValidationError ? error.message : safeErrorMessage(error) });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [request]);

  return <dialog ref={dialog} className="skill-preview-dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-release`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="skill-preview-header">
      <div>
        <h2 id={`${id}-title`} tabIndex={-1} ref={heading}>{title}</h2>
        <p id={`${id}-release`}>SKILL.md · <span className="skill-preview-version">{version}</span> · {platform}</p>
      </div>
      <Button type="button" size="icon" variant="ghost" aria-label="Close skill preview" onClick={onClose}><X size={20} aria-hidden="true" /></Button>
    </header>
    <div className="skill-preview-body" tabIndex={0} aria-label="Skill instructions">
      {result.state === "loading" && <p className="skill-preview-state" role="status">Loading skill instructions…</p>}
      {result.state === "error" && <div className="skill-preview-state"><p role="alert">{result.message}</p><Button type="button" size="sm" variant="outline" onClick={() => { setResult({ state: "loading" }); setRequest(Promise.resolve().then(loadBundle)); }}>Try again</Button></div>}
      {result.state === "ready" && (result.content === null
        ? <p className="skill-preview-state" role="status">This release does not include a root SKILL.md file. Inspect Package files for its other contents.</p>
        : !result.content.trim()
          ? <p className="skill-preview-state" role="status">The SKILL.md file in this release is empty.</p>
          : <SkillMarkdown content={result.content} />)}
    </div>
    <footer className="skill-preview-footer">Preview only. Embedded HTML and images are not loaded.</footer>
  </dialog>;
}

function SkillMarkdown({ content }: { content: string }) {
  // Keep YAML frontmatter inspectable without rendering it as a heading/rule.
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const markdown = frontmatter ? content.slice(frontmatter[0].length) : content;
  return <article className="skill-preview-markdown">
    {frontmatter && <details className="skill-preview-frontmatter"><summary>Skill metadata</summary><pre><code>{frontmatter[1]}</code></pre></details>}
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      // Never fetch image URLs, including tracking pixels in private packages.
      img: ({ alt }) => <span className="skill-preview-image">[Image: {alt || "no description"}]</span>,
      // Package-relative links have no public web destination. Keep their label
      // readable without navigating away or interpreting app-local routes.
      a: ({ href, children }) => href && /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
        : <span>{children}</span>,
      table: ({ children }) => <div className="skill-preview-table" tabIndex={0}><table>{children}</table></div>,
    }}>{markdown}</Markdown>
  </article>;
}
