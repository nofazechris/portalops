import { useEffect, useMemo, useRef, useState } from "react";
import { Link, navigate, usePath } from "../router.jsx";
import { DEFAULT_DOC, DOC_LIST, DOC_SECTIONS, findDoc } from "./docsNav.js";
import { renderDoc, searchDocs } from "./docsRender.js";
import Orb from "../orb.jsx";
import "./pages.css";

// Each markdown file is its own chunk, fetched only when that page (or a search) needs it.
const FILES = import.meta.glob("../../docs/**/*.md", { query: "?raw", import: "default" });
const load = (path) => {
  const loader = FILES[`../../docs/${path}.md`];
  return loader ? loader() : Promise.reject(new Error("missing"));
};

const REPO = "https://github.com/nofazechris/portalops";

function slugFromPath(path) {
  const rest = path.replace(/^\/docs\/?/, "").replace(/\/+$/, "");
  return rest || DEFAULT_DOC;
}

function useSearchIndex(enabled) {
  const [index, setIndex] = useState(null);
  useEffect(() => {
    if (!enabled || index) return undefined;
    let alive = true;
    Promise.all(DOC_LIST.map(async (d) => ({ ...renderDoc(await load(d.path), d.path), path: d.path, section: d.section, title: d.title })))
      .then((i) => { if (alive) setIndex(i); }).catch(() => { if (alive) setIndex([]); });
    return () => { alive = false; };
  }, [enabled, index]);
  return index;
}

function SearchBox({ onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const index = useSearchIndex(open);
  const hits = useMemo(() => (index ? searchDocs(index, q) : []), [index, q]);
  const box = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  return (
    <div className="dx-search" ref={box}>
      <input
        type="search" placeholder="Search the docs" aria-label="Search the docs" value={q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); e.currentTarget.blur(); } }}
      />
      {open && q.trim().length >= 2 && (
        <div className="dx-results" role="listbox">
          {!index && <div className="dx-result-empty">Searching…</div>}
          {index && hits.length === 0 && <div className="dx-result-empty">No results for “{q.trim()}”.</div>}
          {hits.map((h) => (
            <button key={h.path + (h.anchor ?? "")} type="button" className="dx-result" onClick={() => { setOpen(false); setQ(""); onPick(`/docs/${h.path}${h.anchor ? "#" + h.anchor : ""}`); }}>
              <span className="dx-result-title">{h.title}{h.headingText && h.headingText !== h.title ? <em> › {h.headingText}</em> : null}</span>
              <span className="dx-result-snippet">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Docs() {
  const path = usePath();
  const slug = slugFromPath(path);
  const meta = findDoc(slug);
  const [doc, setDoc] = useState(null); // { slug, html, headings, title }
  const [error, setError] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const article = useRef(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    if (!meta) { setDoc(null); return undefined; }
    load(slug).then((md) => { if (alive) setDoc({ slug, ...renderDoc(md, slug) }); }).catch(() => { if (alive) setError("This page could not be loaded."); });
    return () => { alive = false; };
  }, [slug, meta]);

  useEffect(() => { document.title = meta ? `${meta.title} · PortalOps docs` : "PortalOps docs"; }, [meta]);
  useEffect(() => { setMenuOpen(false); }, [slug]);

  // after a page renders: jump to its #anchor, or to the top
  useEffect(() => {
    if (!doc) return;
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
  }, [doc]);

  // links inside the article: docs links navigate in-app, copy buttons copy their code block
  function onArticleClick(e) {
    const copy = e.target.closest?.("[data-copy]");
    if (copy) {
      const code = copy.closest(".dx-code")?.querySelector("code")?.textContent ?? "";
      try { navigator.clipboard?.writeText(code); } catch { /* clipboard unavailable */ }
      copy.textContent = "Copied ✓"; setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      return;
    }
    const a = e.target.closest?.("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute("href");
    if (href.startsWith("/docs")) { e.preventDefault(); navigate(href); }
  }

  const i = DOC_LIST.findIndex((d) => d.path === slug);
  const prev = i > 0 ? DOC_LIST[i - 1] : null;
  const next = i >= 0 && i < DOC_LIST.length - 1 ? DOC_LIST[i + 1] : null;

  return (
    <div className="dx">
      <header className="dx-top">
        <Link href="/" className="brand dx-brand"><span className="brand-mark"><i /></span><span className="brand-name">PortalOps</span></Link>
        <span className="dx-top-label">Docs</span>
        <SearchBox onPick={(href) => navigate(href)} />
        <nav className="dx-top-links" aria-label="Site">
          <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
          <Link href="/app" className="dx-cta">Open dashboard</Link>
        </nav>
        <button type="button" className="dx-menu-btn" aria-expanded={menuOpen} aria-controls="dx-nav" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? "Close" : "Menu"}</button>
      </header>

      <div className="dx-body">
        <nav id="dx-nav" className={"dx-nav" + (menuOpen ? " open" : "")} aria-label="Documentation">
          {DOC_SECTIONS.map((s) => (
            <div key={s.title} className="dx-nav-group">
              <div className="dx-nav-label">{s.title}</div>
              {s.items.map((it) => (
                <Link key={it.path} href={`/docs/${it.path}`} className={"dx-nav-item" + (it.path === slug ? " on" : "")} aria-current={it.path === slug ? "page" : undefined}>{it.title}</Link>
              ))}
            </div>
          ))}
        </nav>

        <main className="dx-main">
          {!meta && (
            <div className="dx-notfound">
              <h1>Page not found</h1>
              <p>There is no documentation page at <code>{path}</code>.</p>
              <Link href="/docs" className="dx-cta">Go to the docs home</Link>
            </div>
          )}
          {meta && error && <div className="dx-notfound"><h1>{meta.title}</h1><p>{error}</p></div>}
          {meta && !error && !doc && <div className="dx-loading"><Orb size={20} state="searching" label="" />Loading…</div>}
          {meta && doc && doc.slug === slug && (
            <>
              <div className="dx-crumb">{meta.section}</div>
              <article ref={article} className="dx-article" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
              <div className="dx-pager">
                {prev ? <Link href={`/docs/${prev.path}`} className="dx-pager-link"><small>Previous</small>{prev.title}</Link> : <span />}
                {next ? <Link href={`/docs/${next.path}`} className="dx-pager-link next"><small>Next</small>{next.title}</Link> : <span />}
              </div>
              <div className="dx-edit"><a href={`${REPO}/blob/main/docs/${slug}.md`} target="_blank" rel="noopener noreferrer">View this page on GitHub</a></div>
            </>
          )}
        </main>

        <aside className="dx-toc" aria-label="On this page">
          {doc && doc.slug === slug && doc.headings.length > 0 && (
            <>
              <div className="dx-nav-label">On this page</div>
              {doc.headings.map((h) => <a key={h.id} href={`#${h.id}`} className={"dx-toc-item l" + h.level} onClick={(e) => { e.preventDefault(); history.replaceState(null, "", "#" + h.id); document.getElementById(h.id)?.scrollIntoView({ block: "start" }); }}>{h.text}</a>)}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
