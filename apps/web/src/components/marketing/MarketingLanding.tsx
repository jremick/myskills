import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const skillKeys = ["notes", "brief", "review", "release"];
const audienceKeys = ["you", "team"];

/** Illustrative product examples; no live account data is used on the public page. */
export function MarketingLanding({ onLogin }: { onLogin: () => void }) {
  const [skill, setSkill] = useState("notes");
  const [audience, setAudience] = useState("you");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const small = window.matchMedia?.("(max-width: 719px)");
    const wide = window.matchMedia?.("(min-width: 960px)");
    const sync = () => { setMobile(small?.matches ?? false); if (wide?.matches) setMenuOpen(false); };
    const scroll = () => setScrolled(window.scrollY > 8);
    sync(); scroll();
    small?.addEventListener("change", sync); wide?.addEventListener("change", sync);
    window.addEventListener("scroll", scroll, { passive: true });
    return () => { small?.removeEventListener("change", sync); wide?.removeEventListener("change", sync); window.removeEventListener("scroll", scroll); };
  }, []);
  useEffect(() => { if (menuOpen) menu.current?.querySelector("a")?.focus(); }, [menuOpen]);
  function selectTab(group: "skill" | "audience", key: string, focus = false) {
    if (group === "skill") setSkill(key); else setAudience(key);
    const tab = root.current?.querySelector<HTMLButtonElement>("#" + (group === "skill" ? "st" : "ut") + "-" + key);
    if (focus) tab?.focus({ preventScroll: true });
    if (group === "skill" && mobile) tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function tabKey(event: KeyboardEvent, group: "skill" | "audience") {
    const keys = group === "skill" ? skillKeys : audienceKeys;
    const current = keys.indexOf(group === "skill" ? skill : audience);
    const forward = event.key === "ArrowRight" || (group === "skill" && event.key === "ArrowDown");
    const back = event.key === "ArrowLeft" || (group === "skill" && event.key === "ArrowUp");
    const next = forward ? (current + 1) % keys.length : back ? (current - 1 + keys.length) % keys.length : event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); selectTab(group, keys[next]!, true);
  }
  return <div className="marketing-landing" id="top" ref={root} onKeyDown={(event) => { if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); } }}>



<svg width="0" height="0" style={{"position":"absolute"}} aria-hidden="true" focusable="false">
  <symbol id="mark" viewBox="12 12 76 76">
    <rect x="14" y="14" width="28" height="28" rx="8" fill="#14B8A6" />
    <rect x="50" y="14" width="28" height="28" rx="8" fill="#F5B53D" />
    <rect x="14" y="50" width="28" height="28" rx="8" fill="#2B3A4E" />
    <rect x="58" y="58" width="28" height="28" rx="8" fill="#FF6B5B" />
  </symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></symbol>
  <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></symbol>
  <symbol id="i-notes" viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></symbol>
  <symbol id="i-brief" viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5M9 13h6M9 16.5h4" /></symbol>
  <symbol id="i-code" viewBox="0 0 24 24"><path d="M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5" /></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M19.5 11A7.5 7.5 0 0 0 6 6.6M4.5 4v3.5H8M4.5 13A7.5 7.5 0 0 0 18 17.4M19.5 20v-3.5H16" /></symbol>
  <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2H5z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19v-.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5v.5" /><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.2A4.5 4.5 0 0 1 20.5 18.5v.5" /></symbol>
  <symbol id="i-review" viewBox="0 0 24 24"><path d="M12 3.5l7 2.8v5.4c0 4.3-2.9 7.3-7 8.8-4.1-1.5-7-4.5-7-8.8V6.3z" /><path d="M9 12l2.2 2.2L15.5 10" /></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></symbol>
  <symbol id="i-history" viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7" /><path d="M12 8v4.2l2.8 1.8" /></symbol>
  <symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 4l8.5 4.5L12 13 3.5 8.5z" /><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" /></symbol>
  <symbol id="i-db" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></symbol>
  <symbol id="i-box" viewBox="0 0 24 24"><path d="M4 8l8-4.2L20 8v8.2L12 20.4 4 16.2z" /><path d="M4 8l8 4.2L20 8M12 12.2v8.2" /></symbol>
  <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z" /></symbol>
  <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M4 7l8 6 8-6" /></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></symbol>
  <symbol id="i-dot" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" /></symbol>
</svg>

<a className="skip-link" href="#main-content" onClick={() => setMenuOpen(false)}>Skip to main content</a>

<header className={`site-header${scrolled ? " is-scrolled" : ""}`}>
  <div className="wrap header-inner">
    <a className="brand" href="#top" aria-label="MySkills, back to top" onClick={() => setMenuOpen(false)}>
      <svg className="mark" aria-hidden="true"><use href="#mark" /></svg>
      <span className="wordmark">MySkills</span>
    </a>
    <nav className="primary-nav" aria-label="Primary">
      <ul >
        <li ><a className="nav-link" href="#what" onClick={() => setMenuOpen(false)}>What's a skill</a></li>
        <li ><a className="nav-link" href="#how" onClick={() => setMenuOpen(false)}>How it works</a></li>
        <li ><a className="nav-link" href="#teams" onClick={() => setMenuOpen(false)}>For teams</a></li>
        <li ><a className="nav-link" href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a></li>
      </ul>
    </nav>
    <div className="header-actions">
      <a className="nav-link" href="/login" onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onLogin(); } }}>Sign in</a>
      <a className="btn btn-primary" href="/registry">Explore skills</a>
      <button className="menu-btn" type="button" aria-controls="mobile-menu" ref={menuButton} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
        <svg className="i i-open" aria-hidden="true"><use href="#i-menu" /></svg>
        <svg className="i i-close" aria-hidden="true"><use href="#i-close" /></svg>
        <span >Menu</span>
      </button>
    </div>
  </div>
  <nav className="mobile-menu" id="mobile-menu" aria-label="Menu" ref={menu} hidden={!menuOpen}>
    <ul >
      <li ><a href="#what" onClick={() => setMenuOpen(false)}>What's a skill</a></li>
      <li ><a href="#how" onClick={() => setMenuOpen(false)}>How it works</a></li>
      <li ><a href="#teams" onClick={() => setMenuOpen(false)}>For teams</a></li>
      <li ><a href="#self-host" onClick={() => setMenuOpen(false)}>Self-host</a></li>
      <li ><a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a></li>
      <li ><a href="/login" onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onLogin(); } }}>Sign in</a></li>
    </ul>
    <a className="btn btn-primary btn-lg" href="/registry">Explore skills</a>
  </nav>
</header>

<main id="main-content">


  <section className="hero" aria-labelledby="hero-title">
    <div className="wrap hero-grid">
      <div className="hero-copy">
        <p className="status-chip"><span className="tile tile-teal" aria-hidden="true"></span><span ><b >Public beta</b> · Hosted accounts by invitation</span></p>
        <h1 id="hero-title">Your AI's best skills, <span className="h1-2">kept in order.</span></h1>
        <p className="lede">Skills are reusable instructions your AI agent follows for tasks like meeting notes or code reviews. MySkills helps you and your team find them, keep the ones you trust and choose when they change.</p>
        <div className="cta-row">
          <a className="btn btn-primary btn-lg" href="/registry">Explore skills <svg className="i" aria-hidden="true"><use href="#i-arrow" /></svg></a>
          <a className="btn btn-secondary btn-lg" href="#teams" onClick={() => setMenuOpen(false)}>See how teams use it</a>
        </div>
        <ul className="hero-meta">
          <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Browse public skills without an account</li>
          <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Open source under Apache 2.0</li>
        </ul>
      </div>

      <figure className="hero-visual" aria-labelledby="hero-visual-cap">
        <svg className="tile-field" aria-hidden="true" focusable="false" viewBox="0 0 780 620">
          <defs >
            <pattern id="tilegrid" width="72" height="72" patternUnits="userSpaceOnUse">
              <rect x="6" y="6" width="60" height="60" rx="17" fill="none" stroke="#E3E9EF" />
            </pattern>
          </defs>
          <rect width="780" height="620" fill="url(#tilegrid)" />
          <rect x="654" y="78" width="60" height="60" rx="17" fill="#E7F6F4" />
          <rect x="582" y="6" width="60" height="60" rx="17" fill="#FEF4E1" />
          <rect x="726" y="510" width="60" height="60" rx="17" fill="#FFEEEB" />
        </svg>
        <figcaption className="illus-tag" id="hero-visual-cap">Illustrative preview</figcaption>

        <div className="ui app-window">
          <div className="app-bar">
            <svg className="mark" aria-hidden="true"><use href="#mark" /></svg>
            <span className="crumb">Libraries<span className="sep" aria-hidden="true">/</span><b >My skills</b></span>
            <span className="app-search" aria-hidden="true"><svg className="i"><use href="#i-search" /></svg>Search skills<kbd >/</kbd></span>
          </div>
          <div className="app-body">
            <div className="skill-list">
              <p className="list-label" id="hero-list-label"><span >My skills</span><span >4</span></p>
              <div className="skill-tabs" role="tablist" aria-label="Skills in this library" aria-orientation={mobile ? "horizontal" : "vertical"} onKeyDown={(event) => tabKey(event, "skill")}>
                <button className="skill-tab" type="button" role="tab" id="st-notes" aria-controls="sp-notes" aria-selected={skill === "notes"} tabIndex={skill === "notes" ? 0 : -1} onClick={() => selectTab("skill", "notes")}>
                  <span className="tile tile-teal" aria-hidden="true"></span>
                  <span ><span className="st-name">Meeting notes to actions</span><span className="st-meta">1.3.0 · Adopted</span></span>
                </button>
                <button className="skill-tab" type="button" role="tab" id="st-brief" aria-controls="sp-brief" aria-selected={skill === "brief"} tabIndex={skill === "brief" ? 0 : -1} onClick={() => selectTab("skill", "brief")}>
                  <span className="tile tile-amber" aria-hidden="true"></span>
                  <span ><span className="st-name">Project brief writer</span><span className="st-meta">0.9.2 · Adopted</span></span>
                </button>
                <button className="skill-tab" type="button" role="tab" id="st-review" aria-controls="sp-review" aria-selected={skill === "review"} tabIndex={skill === "review" ? 0 : -1} onClick={() => selectTab("skill", "review")}>
                  <span className="tile tile-navy" aria-hidden="true"></span>
                  <span ><span className="st-name">Code review checklist</span><span className="st-meta">2.1.0 · Adopted</span></span>
                </button>
                <button className="skill-tab" type="button" role="tab" id="st-release" aria-controls="sp-release" aria-selected={skill === "release"} tabIndex={skill === "release" ? 0 : -1} onClick={() => selectTab("skill", "release")}>
                  <span className="tile tile-coral tile-offset" aria-hidden="true"></span>
                  <span ><span className="st-name">Release notes helper</span><span className="st-meta is-change">Change to review</span></span>
                </button>
              </div>
            </div>

            <div className="skill-panels">
              <section className="skill-panel" role="tabpanel" id="sp-notes" aria-labelledby="st-notes" hidden={skill !== "notes"} inert={skill !== "notes"} tabIndex={skill === "notes" ? 0 : -1}>
                <div className="sp-head"><p className="sp-title">Meeting notes to actions</p><span className="chip chip-teal"><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Adopted 1.3.0</span></div>
                <p className="sp-desc">Turns rough notes or a transcript into decisions, actions with owners and due dates, and open questions.</p>
                <p className="sp-try"><span >Try asking</span>“Tidy up today's project sync.”</p>
                <div className="file-peek">
                  <div className="fp-tabs" aria-hidden="true"><span className="on">SKILL.md</span><span >template.md</span></div>
<pre className="fp-code">{"Turn the notes into three lists:\n1. Decisions, one line each.\n2. Actions: owner, task, due date.\n3. Open questions.\nFlag any action without an owner."}</pre>
                </div>
                <p className="sp-foot"><span ><svg className="i" aria-hidden="true"><use href="#i-refresh" /></svg>Source checked weekly</span><span ><svg className="i" aria-hidden="true"><use href="#i-link" /></svg><span className="mono">github.com/example-org/team-skills</span></span></p>
              </section>

              <section className="skill-panel" role="tabpanel" id="sp-brief" aria-labelledby="st-brief" hidden={skill !== "brief"} inert={skill !== "brief"} tabIndex={skill === "brief" ? 0 : -1}>
                <div className="sp-head"><p className="sp-title">Project brief writer</p><span className="chip chip-teal"><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Adopted 0.9.2</span></div>
                <p className="sp-desc">Drafts a one-page brief from a short request, in the same shape every time: goal, audience, scope, risks and open questions.</p>
                <p className="sp-try"><span >Try asking</span>“Draft a brief for the onboarding refresh.”</p>
                <div className="file-peek">
                  <div className="fp-tabs" aria-hidden="true"><span className="on">SKILL.md</span><span >brief-template.md</span></div>
<pre className="fp-code">{"Write a one-page brief with these sections:\nGoal · Audience · Scope · Risks · Open questions\nAsk before inventing dates or budgets."}</pre>
                </div>
                <p className="sp-foot"><span ><svg className="i" aria-hidden="true"><use href="#i-globe" /></svg>From the public registry</span><span ><svg className="i" aria-hidden="true"><use href="#i-refresh" /></svg>Checks: manual</span></p>
              </section>

              <section className="skill-panel" role="tabpanel" id="sp-review" aria-labelledby="st-review" hidden={skill !== "review"} inert={skill !== "review"} tabIndex={skill === "review" ? 0 : -1}>
                <div className="sp-head"><p className="sp-title">Code review checklist</p><span className="chip chip-teal"><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Adopted 2.1.0</span></div>
                <p className="sp-desc">Checks a change against your team's list before a person reviews it. It points things out and leaves the approval to people.</p>
                <p className="sp-try"><span >Try asking</span>“Review this pull request before I ask the team.”</p>
                <div className="file-peek">
                  <div className="fp-tabs" aria-hidden="true"><span className="on">SKILL.md</span><span >checklist.md</span></div>
<pre className="fp-code">{"Check the change against our list:\n- Tests cover the new behaviour.\n- Names follow our conventions.\n- Errors are handled, not swallowed.\nNever approve. Summarise for a person."}</pre>
                </div>
                <p className="sp-foot"><span ><svg className="i" aria-hidden="true"><use href="#i-refresh" /></svg>Source checked daily</span><span ><svg className="i" aria-hidden="true"><use href="#i-link" /></svg><span className="mono">github.com/example-org/eng-skills</span></span></p>
              </section>

              <section className="skill-panel" role="tabpanel" id="sp-release" aria-labelledby="st-release" hidden={skill !== "release"} inert={skill !== "release"} tabIndex={skill === "release" ? 0 : -1}>
                <div className="sp-head"><p className="sp-title">Release notes helper</p><span className="chip">Adopted 1.5.0</span><span className="chip chip-coral"><svg className="i" aria-hidden="true"><use href="#i-dot" /></svg>1.6.0 to review</span></div>
                <p className="sp-desc">Its source published a change. MySkills saved it as a candidate. Nothing is installed or replaced until you review it and adopt it.</p>
                <div className="file-peek">
                  <div className="fp-tabs" aria-hidden="true"><span className="on">SKILL.md · 1.5.0 → 1.6.0</span></div>
<pre className="fp-code">{"  Write release notes for people, not machines.\n"}<span className="del">{"- Group changes by component."}</span><span className="add">{"+ Group changes by who they affect."}</span><span className="add">{"+ Put breaking changes first."}</span>{"  Link each item to its pull request."}</pre>
                </div>
                <div className="sp-actions" aria-hidden="true"><span className="fake-btn fake-btn-primary"><svg className="i"><use href="#i-check" /></svg>Adopt version 1.6.0</span><span className="fake-btn">Keep 1.5.0</span></div>
                <p className="sp-foot"><span ><svg className="i" aria-hidden="true"><use href="#i-refresh" /></svg>Found by this week's source check</span><span ><svg className="i" aria-hidden="true"><use href="#i-link" /></svg><span className="mono">github.com/example-org/release-tools</span></span></p>
              </section>
            </div>
          </div>
        </div>

        <div className="update-card">
          <span className="uc-mark" aria-hidden="true"><span ></span><span ></span><span ></span><span ></span></span>
          <div >
            <p className="uc-title">A source changed</p>
            <p className="uc-text">Release notes helper 1.6.0 is ready to review. Your 1.5.0 stays in place until you choose.</p>
            <button className="btn btn-secondary" type="button" onClick={() => { selectTab("skill", "release", true); root.current?.querySelector(".app-window")?.scrollIntoView({ block: "nearest", behavior: "auto" }); }}>Review the change</button>
          </div>
        </div>
      </figure>
    </div>
  </section>


  <section className="section section-soft" id="what" aria-labelledby="what-title">
    <div className="wrap">
      <div className="section-head">
        <h2 id="what-title">A skill is a reusable set of instructions for an AI agent.</h2>
        <p >Write one yourself or pick one someone has shared. Use it when that job comes up, so you don't have to explain the task from scratch.</p>
      </div>
      <ul className="examples">
        <li className="example">
          <div className="ex-top"><span className="ex-icon teal" aria-hidden="true"><svg className="i"><use href="#i-notes" /></svg></span><h3 >Prepare meeting notes</h3></div>
          <dl className="ex-flow">
            <div ><dt >You ask</dt><dd ><span className="bubble">“Tidy up today's project sync.”</span></dd></div>
            <div ><dt >The skill tells your agent to</dt><dd >List decisions, owners and due dates in your team's format, and flag anything without an owner.</dd></div>
          </dl>
          <p className="ex-files"><span className="mono">meeting-notes/</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>SKILL.md</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>template.md</span></p>
        </li>
        <li className="example">
          <div className="ex-top"><span className="ex-icon amber" aria-hidden="true"><svg className="i"><use href="#i-brief" /></svg></span><h3 >Write a project brief</h3></div>
          <dl className="ex-flow">
            <div ><dt >You ask</dt><dd ><span className="bubble">“Draft a brief for the onboarding refresh.”</span></dd></div>
            <div ><dt >The skill tells your agent to</dt><dd >Use your one-page shape: goal, audience, scope, risks and open questions.</dd></div>
          </dl>
          <p className="ex-files"><span className="mono">project-brief/</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>SKILL.md</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>brief-template.md</span></p>
        </li>
        <li className="example">
          <div className="ex-top"><span className="ex-icon navy" aria-hidden="true"><svg className="i"><use href="#i-code" /></svg></span><h3 >Review code</h3></div>
          <dl className="ex-flow">
            <div ><dt >You ask</dt><dd ><span className="bubble">“Review this pull request.”</span></dd></div>
            <div ><dt >The skill tells your agent to</dt><dd >Check tests, naming and error handling against your team's list, then leave the approval to a person.</dd></div>
          </dl>
          <p className="ex-files"><span className="mono">code-review/</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>SKILL.md</span><span className="file"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>checklist.md</span></p>
        </li>
      </ul>
      <p className="section-foot">Skills are ordinary folders built around a <code >SKILL.md</code> file, so you can read exactly what your agent will be told.</p>
    </div>
  </section>


  <section className="section" id="use" aria-labelledby="use-title">
    <div className="wrap">
      <div className="section-head">
        <h2 id="use-title">Useful on your own. Stronger with a team.</h2>
        <p >Start with a personal library. When a team needs the same skills, add review, roles and a shared library.</p>
      </div>

      <div className="seg" role="tablist" aria-label="Who it's for" onKeyDown={(event) => tabKey(event, "audience")}>
        <button type="button" role="tab" id="ut-you" aria-controls="up-you" aria-selected={audience === "you"} tabIndex={audience === "you" ? 0 : -1} onClick={() => selectTab("audience", "you")}>For you</button>
        <button type="button" role="tab" id="ut-team" aria-controls="up-team" aria-selected={audience === "team"} tabIndex={audience === "team" ? 0 : -1} onClick={() => selectTab("audience", "team")}>For your team</button>
      </div>

      <div className="use-panels">
      <div className="use-panel" role="tabpanel" id="up-you" aria-labelledby="ut-you" hidden={audience !== "you"} inert={audience !== "you"} tabIndex={audience === "you" ? 0 : -1}>
        <div className="use-copy">
          <h3 >Your own library of skills you trust.</h3>
          <ul className="checks">
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Save skills from the public registry, or from a public GitHub link.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Read every file before you use it.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Get an in-app notice when a source changes, then update when you're ready.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Roll back if a new version doesn't suit you.</span></li>
          </ul>
          <a className="btn btn-primary btn-lg" href="/registry">Explore skills <svg className="i" aria-hidden="true"><use href="#i-arrow" /></svg></a>
        </div>
        <figure className="use-visual" aria-labelledby="you-cap">
          <figcaption className="illus-tag" id="you-cap">Illustrative preview</figcaption>
          <div className="ui">
            <div className="ui-head">
              <svg className="i" aria-hidden="true" style={{"color":"var(--ink-500)"}}><use href="#i-folder" /></svg>
              <span className="ui-title">My skills</span><span className="chip">Personal library</span>
              <span className="notify push"><span className="fake-switch" aria-hidden="true"></span>Notify me about changes</span>
            </div>
            <ul className="lib-rows">
              <li ><span className="tile tile-teal" aria-hidden="true"></span><span ><span className="lib-name">Meeting notes to actions</span><span className="lib-sub"> · 1.3.0 · checked weekly</span></span><span className="chip chip-teal">Adopted</span></li>
              <li ><span className="tile tile-amber" aria-hidden="true"></span><span ><span className="lib-name">Project brief writer</span><span className="lib-sub"> · 0.9.2 · manual checks</span></span><span className="chip chip-teal">Adopted</span></li>
              <li ><span className="tile tile-coral tile-offset" aria-hidden="true"></span><span ><span className="lib-name">Release notes helper</span><span className="lib-sub"> · 1.5.0 · checked weekly</span></span><span className="chip chip-coral">1.6.0 to review</span></li>
            </ul>
            <div className="lib-add" aria-hidden="true">
              <span className="lib-input"><svg className="i"><use href="#i-link" /></svg>Paste a public GitHub link</span>
              <span className="fake-btn">Save source</span>
            </div>
          </div>
          <div className="inbox">
            <span className="inbox-icon" aria-hidden="true"><svg className="i"><use href="#i-bell" /></svg></span>
            <div ><b >Changes</b><p >Release notes helper: a new candidate was found in its source. Your adopted version hasn't changed.</p></div>
          </div>
        </figure>
      </div>

      <div className="use-panel" role="tabpanel" id="up-team" aria-labelledby="ut-team" hidden={audience !== "team"} inert={audience !== "team"} tabIndex={audience === "team" ? 0 : -1}>
        <div className="use-copy">
          <h3 >One reviewed set of skills for everyone.</h3>
          <ul className="checks">
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Curate a team library from releases your members are allowed to use.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Send new skills and new versions through review before they're published.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Give people roles (author, maintainer, admin) and protect admin actions with MFA.</span></li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-check" /></svg><span >Keep version history for every release and an audit log of key actions.</span></li>
          </ul>
          <a className="btn btn-secondary btn-lg" href="#teams" onClick={() => setMenuOpen(false)}>See team features</a>
        </div>
        <figure className="use-visual" aria-labelledby="team-cap">
          <figcaption className="illus-tag" id="team-cap">Illustrative preview</figcaption>
          <div className="ui">
            <div className="ui-head">
              <svg className="i" aria-hidden="true" style={{"color":"var(--ink-500)"}}><use href="#i-users" /></svg>
              <span className="ui-title">Support team</span><span className="chip">Team library</span>
              <span className="lib-sub push">Curated by team owners</span>
            </div>
            <ul className="lib-rows">
              <li className="has-note"><span className="tile tile-navy" aria-hidden="true"></span><span ><span className="lib-name">Customer reply tone</span><span className="lib-sub"> · 1.2.0</span></span><span className="chip chip-teal">Adopted by team</span></li>
            </ul>
            <p className="curator"><b >Curator note</b>Use 1.2.0. It follows the updated tone guide from March.</p>
            <ul className="lib-rows">
              <li ><span className="tile tile-teal" aria-hidden="true"></span><span ><span className="lib-name">Escalation summary</span><span className="lib-sub"> · 2.0.0</span></span><span className="chip chip-teal">Adopted by team</span></li>
              <li ><span className="tile tile-amber" aria-hidden="true"></span><span ><span className="lib-name">Refund policy lookup</span><span className="lib-sub"> · 0.4.1</span></span><span className="chip chip-amber">In review</span></li>
            </ul>
            <p className="roles"><span >Roles on this instance:</span><span className="chip">Owner</span><span className="chip">Admin</span><span className="chip">Maintainer</span><span className="chip">Author</span></p>
          </div>
        </figure>
      </div>
      </div>
    </div>
  </section>


  <section className="section section-soft" id="how" aria-labelledby="how-title">
    <div className="wrap">
      <div className="section-head section-head-row">
        <div >
          <h2 id="how-title">You decide what changes, and when.</h2>
          <p >Finding, checking, choosing and installing are separate steps. Nothing on your computer changes until you say so.</p>
        </div>
        <p className="illus-tag">Previews are illustrative</p>
      </div>
      <ol className="steps">
        <li className="step">
          <div className="step-marker"><span className="tile tile-teal" aria-hidden="true"></span></div>
          <h3 >Find</h3>
          <p >Browse the registry, or save a public GitHub link to a library. Saving doesn't run code or install anything.</p>
          <div className="step-frag" aria-hidden="true">
            <span className="f-input"><svg className="i"><use href="#i-link" /></svg><span className="mono">github.com/example-org/skills</span></span>
            <span className="fake-btn" style={{"alignSelf":"flex-start"}}>Save source</span>
          </div>
        </li>
        <li className="step">
          <div className="step-marker"><span className="tile tile-amber" aria-hidden="true"></span></div>
          <h3 >Check</h3>
          <p >Read the instructions and files first. Where recorded, see what a release was designed for and what it was tested on.</p>
          <div className="step-frag" aria-hidden="true">
            <ul className="f-files"><li ><svg className="i"><use href="#i-file" /></svg>SKILL.md</li><li ><svg className="i"><use href="#i-file" /></svg>template.md</li></ul>
            <span className="chip chip-teal" style={{"alignSelf":"flex-start"}}><svg className="i"><use href="#i-check" /></svg>Scan: no findings</span>
          </div>
        </li>
        <li className="step">
          <div className="step-marker"><span className="tile tile-navy" aria-hidden="true"></span></div>
          <h3 >Choose</h3>
          <p >Pick the exact version you, or your team, recommend. Choosing a version doesn't touch anything already installed.</p>
          <div className="step-frag" aria-hidden="true">
            <div className="f-version"><span className="mono">1.3.0</span><span className="fake-btn fake-btn-primary"><svg className="i"><use href="#i-check" /></svg>Adopt version</span></div>
            <p className="f-note">Installed files unchanged</p>
          </div>
        </li>
        <li className="step">
          <div className="step-marker"><span className="tile tile-coral tile-offset" aria-hidden="true"></span></div>
          <h3 >Install and update</h3>
          <p >Install with one command. When a source changes, you get a change to review, not a silent update. Roll back if you need to.</p>
          <div className="step-frag frag-term" aria-hidden="true">
            <p ><span className="p">$</span> myskills install meeting-notes</p>
            <p className="ok">✓ Installed 1.3.0</p>
            <p className="warn">1.4.0 found in source · review first</p>
          </div>
        </li>
      </ol>
      <p className="surfaces"><span >Use it where you work:</span><span className="chip">Web app</span><span className="chip">Command line</span><span className="chip">API</span><span className="chip">MCP for agent discovery</span></p>
    </div>
  </section>


  <section className="section section-dark" id="teams" aria-labelledby="teams-title">
    <div className="wrap">
      <div className="teams-grid">
        <div className="teams-copy">
          <p className="eyebrow">For teams and administrators</p>
          <h2 id="teams-title">A shared skill library, with review built in.</h2>
          <p className="lede-dark">Give everyone the same approved instructions. Decide who can publish, see what changed, and roll out updates when you're ready.</p>
          <ul className="features">
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-review" /></svg></span><div ><h3 >Review before publishing</h3><p >New skills and new versions wait for a maintainer's decision, with validation and scan results attached.</p></div></li>
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-layers" /></svg></span><div ><h3 >Team libraries</h3><p >Curate the releases your team should use, with a note explaining the choice.</p></div></li>
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-users" /></svg></span><div ><h3 >Roles and permissions</h3><p >Owners, admins, maintainers and authors each get the access their work needs.</p></div></li>
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-refresh" /></svg></span><div ><h3 >Controlled updates</h3><p >Install, update and rollback are explicit. Connected targets follow your upgrade policy.</p></div></li>
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-lock" /></svg></span><div ><h3 >Sign-in you control</h3><p >Invitation-only registration, MFA and scoped API tokens.</p></div></li>
            <li ><span className="f-icon" aria-hidden="true"><svg className="i"><use href="#i-history" /></svg></span><div ><h3 >A record of what changed</h3><p >Version history for every release, and an audit log of key actions.</p></div></li>
          </ul>
        </div>

        <figure className="review-visual" aria-labelledby="review-cap">
          <figcaption className="illus-tag illus-tag-dark" id="review-cap">Illustrative preview</figcaption>
          <div className="ui">
            <div className="ui-head"><svg className="i" aria-hidden="true" style={{"color":"var(--ink-500)"}}><use href="#i-review" /></svg><span className="ui-title">Review queue</span><span className="chip push">2 waiting</span></div>
            <div className="review-item">
              <div className="ri-top">
                <span className="tile tile-navy" aria-hidden="true"></span>
                <div ><p className="ri-name">Customer reply tone</p><p className="ri-meta">1.2.0 · submitted by an author · Support team</p></div>
                <span className="chip chip-amber">Awaiting maintainer</span>
              </div>
              <ul className="ri-checks">
                <li className="ok"><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Package is valid</li>
                <li className="ok"><svg className="i" aria-hidden="true"><use href="#i-check" /></svg>Scan: no findings</li>
                <li className="info"><svg className="i" aria-hidden="true"><use href="#i-file" /></svg>2 files changed since 1.1.0</li>
              </ul>
              <div className="ri-actions" aria-hidden="true"><span className="fake-btn">Request changes</span><span className="fake-btn fake-btn-primary">Approve and publish</span></div>
            </div>
            <div className="audit">
              <p className="audit-title">Recent activity</p>
              <ol >
                <li ><time >10:15</time><span >Scan of 1.2.0 completed with no findings</span><span className="who">system</span></li>
                <li ><time >09:42</time><span >Submitted 1.2.0 for review</span><span className="who">author</span></li>
                <li ><time >Mon</time><span >Adopted 1.1.0 in Support team library</span><span className="who">team owner</span></li>
                <li ><time >Mon</time><span >Approved and published 1.1.0</span><span className="who">maintainer</span></li>
              </ol>
            </div>
          </div>
        </figure>
      </div>

      <section className="selfhost" id="self-host" aria-labelledby="selfhost-title">
        <div >
          <h3 id="selfhost-title">Open source. Run it on your own infrastructure.</h3>
          <p className="sh-text">MySkills is open source under the Apache 2.0 licence. Host your own instance to keep accounts, roles and skill packages on systems you manage.</p>
          <div className="cta-row">
            <a className="btn btn-on-dark btn-lg" href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md">Read the self-hosting guide</a>
            <a className="btn btn-ghost-dark btn-lg" href="https://github.com/jremick/myskills">View the source</a>
          </div>
        </div>
        <div className="sh-needs">
          <p className="sh-label">What you'll need</p>
          <ul >
            <li ><svg className="i" aria-hidden="true"><use href="#i-db" /></svg>PostgreSQL database</li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-box" /></svg>S3-compatible object storage</li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-lock" /></svg>An HTTPS reverse proxy</li>
            <li ><svg className="i" aria-hidden="true"><use href="#i-mail" /></svg>Email through SMTP or Resend</li>
          </ul>
          <p className="sh-note">A production Docker Compose example is included.</p>
        </div>
        <p className="beta-line"><svg className="i" aria-hidden="true"><use href="#i-info" /></svg><span ><b >Public beta.</b> Ready for real trial use. Not yet recommended for business-critical production.</span></p>
      </section>
    </div>
  </section>


  <section className="section" id="faq" aria-labelledby="faq-title">
    <div className="wrap faq-grid">
      <div className="faq-head">
        <h2 id="faq-title">Questions, answered plainly.</h2>
        <p >Something else? <a href="https://github.com/jremick/myskills/issues">Ask on GitHub</a>.</p>
      </div>
      <div className="faq-list">
        <details >
          <summary ><span >What is a skill, exactly?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >A folder of instructions, sometimes with templates or examples, that an AI agent can use when a task calls for it. The main file, <code >SKILL.md</code>, is plain text, so you can read exactly what your agent will be told.</p></div>
        </details>
        <details >
          <summary ><span >Is this for tracking my staff's skills or training?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >No. MySkills manages instructions for AI agents. It doesn't track people's competencies, courses or certifications.</p></div>
        </details>
        <details >
          <summary ><span >Which AI tools does it work with?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >It depends on the tool and on how you install. Each release lists the platforms its author supports. You can export a reviewed skill as files, install it with the command line, or let an agent that supports MCP search skills and get install guidance.</p><p >Check a skill's details and the <a href="https://github.com/jremick/myskills/blob/main/docs/COMPATIBILITY.md">compatibility guide</a> for current support.</p></div>
        </details>
        <details >
          <summary ><span >Will a skill change without me knowing?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >No. When a saved source changes, MySkills records a candidate for you to review. The version you chose stays in place, and installed files change only when you run an update.</p></div>
        </details>
        <details >
          <summary ><span >Can I sign up on myskills.sh?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >Hosted accounts are invitation-only during the public beta. Anyone can browse public skills without an account. If you want your own space now, you can run your own instance.</p></div>
        </details>
        <details >
          <summary ><span >Is it ready for my organisation?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >It's a public beta for real trial use. APIs, package formats and deployment defaults may still change, and it isn't yet recommended for business-critical production. Self-hosting is the best way to evaluate it.</p></div>
        </details>
        <details >
          <summary ><span >Is MySkills open source?</span><svg className="i" aria-hidden="true"><use href="#i-chevron" /></svg></summary>
          <div className="faq-body"><p >Yes. The code is on GitHub under the Apache 2.0 licence.</p></div>
        </details>
      </div>
    </div>
  </section>


  <section className="section section-soft" id="access" aria-labelledby="access-title">
    <div className="wrap">
      <div className="section-head">
        <h2 id="access-title">Three ways to start.</h2>
        <p >Pick whichever fits. You can look around before you decide anything.</p>
      </div>
      <ul className="routes">
        <li className="route route-primary">
          <span className="tile tile-teal" aria-hidden="true"></span>
          <h3 >Browse public skills</h3>
          <p >Look around the public registry and read any public skill. No account needed.</p>
          <span className="route-spacer"></span>
          <a className="btn btn-primary btn-lg" href="/registry">Explore skills <svg className="i" aria-hidden="true"><use href="#i-arrow" /></svg></a>
        </li>
        <li className="route">
          <span className="tile tile-amber" aria-hidden="true"></span>
          <h3 >Join the hosted beta</h3>
          <p >Accounts on myskills.sh are invitation-only for now. Invited? Open the link in your email to set up your account, then sign in.</p>
          <span className="route-spacer"></span>
          <a className="btn btn-secondary btn-lg" href="/login" onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onLogin(); } }}>Sign in</a>
        </li>
        <li className="route">
          <span className="tile tile-navy" aria-hidden="true"></span>
          <h3 >Run your own instance</h3>
          <p >Self-host the open-source registry for yourself or your organisation. You control accounts, roles and data.</p>
          <span className="route-spacer"></span>
          <a className="btn btn-secondary btn-lg" href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md">Self-hosting guide</a>
        </li>
      </ul>
      <p className="beta-note"><b >Public beta.</b> MySkills is ready for real trial use. APIs, package formats and deployment defaults may still change before a stable release.</p>
    </div>
  </section>

</main>

<footer className="site-footer">
  <div className="wrap footer-grid">
    <div className="footer-brand">
      <a className="brand" href="#top" aria-label="MySkills, back to top" onClick={() => setMenuOpen(false)}>
        <svg className="mark" aria-hidden="true"><use href="#mark" /></svg>
        <span className="wordmark">MySkills</span>
      </a>
      <p >Reusable AI skills, reviewed and kept in order.</p>
    </div>
    <nav className="footer-col" aria-labelledby="f-product">
      <h2 id="f-product">Product</h2>
      <ul >
        <li ><a href="/registry">Explore skills</a></li>
        <li ><a href="/login" onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onLogin(); } }}>Sign in</a></li>
        <li ><a href="#how" onClick={() => setMenuOpen(false)}>How it works</a></li>
        <li ><a href="#teams" onClick={() => setMenuOpen(false)}>For teams</a></li>
      </ul>
    </nav>
    <nav className="footer-col" aria-labelledby="f-project">
      <h2 id="f-project">Project</h2>
      <ul >
        <li ><a href="https://github.com/jremick/myskills">Source on GitHub</a></li>
        <li ><a href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md">Self-hosting guide</a></li>
        <li ><a href="https://github.com/jremick/myskills/blob/main/SECURITY.md">Report a security issue</a></li>
      </ul>
    </nav>
  </div>
  <div className="wrap footer-base">
    <p >Open source under the Apache 2.0 licence.</p>
    <p >Product previews use illustrative data.</p>
  </div>
</footer>







  </div>;
}
