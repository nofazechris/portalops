import { Marked } from "marked";
import { findDoc } from "./docsNav.js";

// Turns the repository's markdown into HTML for the docs site. Pure functions: no DOM, unit-tested in docsRender.test.js.
// The input is our own markdown, bundled at build time (never user input), so it is rendered as-is; raw HTML in the source is escaped anyway.

export const REPO_BLOB = "https://github.com/nofazechris/portalops/blob/main/";

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub-style heading id, so anchors in the markdown (`#finality`) work unchanged on the site. */
export const slugify = (text) =>
  text.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

/** Resolves `a/b/../c` style paths. Returns null if it climbs above the root. */
function normalize(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") { if (!out.length) return null; out.pop(); } else out.push(p);
  }
  return out.join("/");
}

/**
 * Where a link found in doc `fromPath` should point on the site.
 *   external      → as is, new tab
 *   #anchor       → same page
 *   other.md#x    → /docs/<resolved>#x   (if that doc is on the site)
 *   anything else inside the repo → the file on GitHub
 */
export function docHref(fromPath, href) {
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false, local: true };
  const [pathPart, hash] = href.split("#");
  const dir = fromPath.split("/").slice(0, -1);
  const resolved = normalize([...dir, ...pathPart.split("/")]); // relative to /docs
  if (resolved !== null) {
    const noExt = resolved.replace(/\.md$/, "").replace(/\/$/, "");
    if (findDoc(noExt)) return { href: `/docs/${noExt}${hash ? "#" + hash : ""}`, external: false };
    if (!pathPart.endsWith(".md") && noExt === "") return { href: "/docs", external: false };
    return { href: `${REPO_BLOB}docs/${resolved}${hash ? "#" + hash : ""}`, external: true };
  }
  // outside /docs (for example ../../packages/sdk/README.md): resolve against the repository root
  const fromRepo = normalize(["docs", ...dir, ...pathPart.split("/")]);
  return { href: fromRepo ? `${REPO_BLOB}${fromRepo}${hash ? "#" + hash : ""}` : href, external: true };
}

/**
 * @returns {{ html: string, headings: {level:number,id:string,text:string}[], title: string, text: string }}
 */
export function renderDoc(markdown, docPath) {
  const headings = [];
  const seen = new Map();
  let title = "";
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      html({ text }) { return escapeHtml(text); }, // never pass raw HTML through
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = tokens.map((t) => t.raw ?? t.text ?? "").join("").replace(/[`*_]/g, "");
        let id = slugify(plain);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 1 && !title) title = plain;
        if (depth === 2 || depth === 3) headings.push({ level: depth, id, text: plain });
        const anchor = depth === 1 ? "" : `<a class="dx-anchor" href="#${id}" aria-label="Link to this section">#</a>`;
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang ?? "").split(/\s/)[0];
        if (language === "mermaid") {
          return `<details class="dx-diagram"><summary>Diagram (source: renders as a picture on GitHub)</summary><pre><code>${escapeHtml(text)}</code></pre></details>\n`;
        }
        return `<div class="dx-code"><div class="dx-code-head"><span>${escapeHtml(language || "text")}</span><button type="button" class="dx-copy" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
      },
      link({ href, title: t, tokens }) {
        const r = docHref(docPath, href);
        const inner = this.parser.parseInline(tokens);
        return `<a href="${escapeHtml(r.href)}"${t ? ` title="${escapeHtml(t)}"` : ""}${r.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
      table(token) {
        const head = token.header.map((c, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows.map((r) => `<tr>${r.map((c, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
        return `<div class="dx-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = md.parse(markdown);
  const text = markdown.replace(/```[\s\S]*?```/g, " ").replace(/[`*_>#|]/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ");
  return { html, headings, title, text };
}

/** Case-insensitive search over rendered docs. Titles and headings rank above body text. */
export function searchDocs(index, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const out = [];
  for (const d of index) {
    const title = d.title.toLowerCase();
    const heads = d.headings.map((h) => h.text.toLowerCase());
    const body = d.text.toLowerCase();
    if (!words.every((w) => title.includes(w) || heads.some((h) => h.includes(w)) || body.includes(w))) continue;
    let score = 0;
    for (const w of words) { if (title.includes(w)) score += 10; if (heads.some((h) => h.includes(w))) score += 4; if (body.includes(w)) score += 1; }
    const at = body.indexOf(words[0]);
    const snippet = at < 0 ? "" : (at > 40 ? "…" : "") + d.text.slice(Math.max(0, at - 40), at + 110).trim() + "…";
    const heading = d.headings.find((h) => words.some((w) => h.text.toLowerCase().includes(w)));
    out.push({ path: d.path, title: d.title, section: d.section, snippet, anchor: heading?.id ?? null, headingText: heading?.text ?? null, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
