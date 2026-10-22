import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DOC, DOC_LIST, INTERNAL_DOCS } from "./docsNav.js";
import { REPO_BLOB, docHref, renderDoc, searchDocs, slugify } from "./docsRender.js";

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : p.endsWith(".md") && out.push(p); } return out; };

test("docs site: every listed page exists, none is listed twice, and every page on disk is listed or deliberately internal", () => {
  const onDisk = walk(DOCS).map((p) => relative(DOCS, p).replace(/\\/g, "/").replace(/\.md$/, ""));
  const listed = DOC_LIST.map((d) => d.path);
  assert.deepEqual(listed.filter((p) => !onDisk.includes(p)), [], "listed but missing on disk");
  assert.equal(new Set(listed).size, listed.length, "no duplicates");
  assert.deepEqual(onDisk.filter((p) => !listed.includes(p) && !INTERNAL_DOCS.includes(p)), [], "on disk but invisible: add to docsNav.js (or INTERNAL_DOCS)");
  assert.ok(listed.includes(DEFAULT_DOC));
});

test("slugs match GitHub's, so anchors written in the markdown keep working", () => {
  assert.equal(slugify("Finality"), "finality");
  assert.equal(slugify("GET /api/v1/events/:eventId"), "get-apiv1eventseventid");
  assert.equal(slugify("What has and has not been verified"), "what-has-and-has-not-been-verified");
  assert.equal(slugify("`signature`: Node.js with the SDK"), "signature-nodejs-with-the-sdk");
});

test("links: other docs become site pages, anchors stay, repo files go to GitHub, external opens a new tab", () => {
  assert.deepEqual(docHref("guides/quickstart", "concepts.md#finality"), { href: "/docs/guides/concepts#finality", external: false });
  assert.deepEqual(docHref("guides/quickstart", "../reference/api.md"), { href: "/docs/reference/api", external: false });
  assert.deepEqual(docHref("guides/quickstart", "#next"), { href: "#next", external: false, local: true });
  assert.deepEqual(docHref("guides/quickstart", "https://example.com/x"), { href: "https://example.com/x", external: true });
  assert.equal(docHref("guides/sdk", "../../packages/sdk/README.md").href, REPO_BLOB + "packages/sdk/README.md");
  assert.equal(docHref("guides/sdk", "../operations/crash-investigation.md").href, REPO_BLOB + "docs/operations/crash-investigation.md", "internal docs link to GitHub, not a dead page");
  assert.equal(docHref("guides/sdk", "../security/").href, REPO_BLOB + "docs/security", "a folder link goes to the folder on GitHub");
});

test("rendering: headings get ids and a table of contents, code gets a copy button, tables scroll, HTML is escaped", () => {
  const md = "# Title\n\nIntro with `code`.\n\n## First\n\ntext\n\n## First\n\n### Sub\n\n```bash\nnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[go](other.md#x)\n";
  const r = renderDoc(md, "guides/quickstart");
  assert.equal(r.title, "Title");
  assert.deepEqual(r.headings.map((h) => [h.level, h.id]), [[2, "first"], [2, "first-1"], [3, "sub"]], "duplicate headings are disambiguated like GitHub");
  assert.match(r.html, /<h2 id="first">First<a class="dx-anchor" href="#first"/);
  assert.match(r.html, /class="dx-code"[\s\S]*data-copy[\s\S]*npm test/);
  assert.match(r.html, /<div class="dx-table"><table>/);
  assert.ok(!r.html.includes("<script>"), "raw HTML is escaped");
  assert.match(r.html, /&lt;script&gt;/);
  assert.match(r.html, /<a href="https:\/\/github\.com\/nofazechris\/portalops\/blob\/main\/docs\/guides\/other\.md#x"/);
});

test("rendering: mermaid blocks are kept as readable source, not dropped", () => {
  const r = renderDoc("# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\n", "architecture/overview");
  assert.match(r.html, /dx-diagram/);
  assert.match(r.html, /flowchart LR/);
});

test("every real doc renders without error, has a title, and none of its internal links is dead", () => {
  const problems = [];
  for (const d of DOC_LIST) {
    const md = readFileSync(join(DOCS, d.path + ".md"), "utf8");
    const r = renderDoc(md, d.path);
    if (!r.title) problems.push(`${d.path}: no H1 title`);
    for (const m of md.replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)\s]+)\)/g)) {
      const l = docHref(d.path, m[1]);
      if (l.href.startsWith("/docs/")) {
        const target = l.href.slice(6).split("#")[0];
        if (target && !DOC_LIST.some((x) => x.path === target)) problems.push(`${d.path}: ${m[1]} → ${l.href}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("search: titles and headings outrank body text; short or empty queries return nothing", () => {
  const idx = DOC_LIST.slice(0, 3).map((d) => ({ ...renderDoc(readFileSync(join(DOCS, d.path + ".md"), "utf8"), d.path), path: d.path, section: d.section, title: d.title }));
  assert.deepEqual(searchDocs(idx, "a"), []);
  assert.deepEqual(searchDocs(idx, "  "), []);
  const hits = searchDocs([
    { path: "a", title: "Webhooks", section: "G", headings: [], text: "nothing relevant here" },
    { path: "b", title: "Other", section: "G", headings: [{ id: "x", text: "Signatures", level: 2 }], text: "the word webhooks appears once" },
  ], "webhooks");
  assert.equal(hits[0].path, "a");
  assert.equal(hits[1].path, "b");
  assert.equal(existsSync(DOCS), true);
});
