import test from "node:test";
import assert from "node:assert/strict";
import { applyKey, cursorPosition, highlight } from "./codeEditor.js";
import { MISSIONS } from "./arenaLab.js";

const at = (value, start = value.length, end = start) => ({ value, start, end });

test("highlight: tokens get classes, and the text survives (escaped) unchanged", () => {
  const html = highlight('const x = "a<b" + 12; // note\nreturn foo(x);');
  assert.match(html, /<span class="tk-kw">const<\/span>/);
  assert.match(html, /<span class="tk-str">"a&lt;b"<\/span>/);
  assert.match(html, /<span class="tk-num">12<\/span>/);
  assert.match(html, /<span class="tk-com">\/\/ note<\/span>/);
  assert.match(html, /<span class="tk-fn">foo<\/span>/);
  const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(text, 'const x = "a<b" + 12; // note\nreturn foo(x);\n');
});

test("highlight: every starter and solution round-trips and never injects markup", () => {
  for (const m of MISSIONS) for (const code of [m.starter, m.solution]) {
    const html = highlight(code);
    const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.equal(text, code + "\n", m.id);
    assert.equal((html.match(/<(?!\/?span\b)/g) ?? []).length, 0, "only span tags");
  }
});

test("highlight: regex literals, properties and division", () => {
  assert.match(highlight("x = /^[0-9a-f]{64}$/.test(s);"), /<span class="tk-re">\/\^\[0-9a-f\]\{64\}\$\/<\/span>/);
  assert.doesNotMatch(highlight("const r = a / b / c;"), /tk-re/);
  assert.match(highlight("state.players"), /<span class="tk-prop">players<\/span>/);
});

test("editor: Tab inserts two spaces; multi-line Tab and Shift+Tab indent and dedent", () => {
  assert.deepEqual(applyKey(at("ab", 1), "Tab"), at("a  b", 3));
  const r = applyKey(at("a\nb", 0, 3), "Tab");
  assert.equal(r.value, "  a\n  b");
  assert.equal(applyKey(at(r.value, 0, r.value.length), "Tab", { shift: true }).value, "a\nb");
});

test("editor: Enter keeps the indent, adds one after an opening brace, and expands {}", () => {
  assert.deepEqual(applyKey(at("  foo();"), "Enter"), at("  foo();\n  ", 11));
  assert.equal(applyKey(at("if (x) {"), "Enter").value, "if (x) {\n  ");
  const r = applyKey(at("f() {}", 5), "Enter");
  assert.equal(r.value, "f() {\n  \n}");
  assert.equal(r.start, 8);
});

test("editor: brackets and quotes pair up, are skipped over, and are removed together", () => {
  assert.deepEqual(applyKey(at("", 0), "("), at("()", 1));
  assert.deepEqual(applyKey(at("()", 1), ")"), at("()", 2));
  assert.deepEqual(applyKey(at("()", 1), "Backspace"), at("", 0));
  assert.deepEqual(applyKey(at("x", 0, 1), '"'), at('"x"', 1, 2));
  assert.equal(applyKey(at("don", 3), "'"), null, "an apostrophe inside a word is left alone");
  assert.equal(applyKey(at("ab", 1), "("), null, "no pair before a letter");
});

test("editor: Ctrl+/ comments and uncomments lines", () => {
  const on = applyKey(at("a\n  b", 0, 5), "/", { mod: true });
  assert.equal(on.value, "// a\n  // b");
  assert.equal(applyKey(at(on.value, 0, on.value.length), "/", { mod: true }).value, "a\n  b");
});

test("editor: cursorPosition is 1-based", () => {
  assert.deepEqual(cursorPosition("ab\ncd", 4), { line: 2, col: 2 });
  assert.deepEqual(cursorPosition("", 0), { line: 1, col: 1 });
});
