// The small amount of editor behaviour a code box needs to feel like a real one, as pure functions so it can be tested:
// syntax highlighting (highlight) and key handling (applyKey: indent, auto-indent, auto-close, skip-over, comment toggle).

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export", "extends", "finally", "for",
  "function", "if", "import", "in", "instanceof", "let", "new", "of", "return", "switch", "throw", "try", "typeof", "var", "void", "while", "yield",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "this"]);
const BUILTINS = new Set(["Math", "Number", "String", "Object", "Array", "JSON", "Date", "Boolean", "Promise", "crypto", "console", "Map", "Set", "Error"]);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls, s) => '<span class="tk-' + cls + '">' + esc(s) + "</span>";
const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

/** JavaScript to HTML: comments, strings, numbers, keywords, literals, function names and properties wrapped in <span class="tk-*">. */
export function highlight(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let prevSignificant = ""; // last non-space char, to tell a regex from a division
  while (i < n) {
    const c = code[i];
    const two = code.slice(i, i + 2);
    if (two === "//") {
      let j = code.indexOf("\n", i); if (j === -1) j = n;
      out += span("com", code.slice(i, j)); i = j; continue;
    }
    if (two === "/*") {
      let j = code.indexOf("*/", i + 2); j = j === -1 ? n : j + 2;
      out += span("com", code.slice(i, j)); i = j; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && code[j] !== c && (c === "`" || code[j] !== "\n")) { if (code[j] === "\\") j++; j++; }
      j = Math.min(n, j + 1);
      out += span("str", code.slice(i, j)); prevSignificant = c; i = j; continue;
    }
    if (c === "/" && (prevSignificant === "" || "(,=:[!&|?{};".includes(prevSignificant))) {
      // a regular expression literal
      let j = i + 1, inClass = false;
      while (j < n && code[j] !== "\n" && (inClass || code[j] !== "/")) { if (code[j] === "\\") j++; else if (code[j] === "[") inClass = true; else if (code[j] === "]") inClass = false; j++; }
      if (code[j] === "/") { j++; while (j < n && /[a-z]/.test(code[j])) j++; out += span("re", code.slice(i, j)); prevSignificant = "/"; i = j; continue; }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX_.]/.test(code[j])) j++;
      out += span("num", code.slice(i, j)); prevSignificant = "0"; i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(code[j])) j++;
      const word = code.slice(i, j);
      let k = j; while (code[k] === " ") k++;
      const afterDot = prevSignificant === ".";
      let cls = null;
      if (!afterDot && KEYWORDS.has(word)) cls = "kw";
      else if (!afterDot && LITERALS.has(word)) cls = "lit";
      else if (!afterDot && BUILTINS.has(word)) cls = "bi";
      else if (code[k] === "(") cls = "fn";
      else if (afterDot) cls = "prop";
      out += cls ? span(cls, word) : esc(word);
      prevSignificant = "a"; i = j; continue;
    }
    out += esc(c);
    if (c !== " " && c !== "\n" && c !== "\t") prevSignificant = c;
    i++;
  }
  return out + "\n"; // a trailing newline keeps the overlay as tall as the textarea
}

const OPEN = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSERS = new Set([")", "]", "}"]);
const lineStart = (v, pos) => v.lastIndexOf("\n", pos - 1) + 1;

/** Position (1-based line and column) of an offset, for the status bar. */
export function cursorPosition(value, offset) {
  const before = value.slice(0, offset);
  const line = before.split("\n").length;
  return { line, col: offset - lineStart(value, offset) + 1 };
}

/**
 * Handle one key press. state = { value, start, end }; returns the new { value, start, end }, or null to let the browser do its default.
 * key: KeyboardEvent.key. mods: { shift, mod } (mod = ctrl or meta).
 */
export function applyKey(state, key, mods = {}) {
  const { value, start, end } = state;
  const hasSel = start !== end;
  const next = value[end] ?? "";
  const prev = value[start - 1] ?? "";

  if (mods.mod && key === "/") {
    const a = lineStart(value, start);
    let b = value.indexOf("\n", end); if (b === -1) b = value.length;
    const lines = value.slice(a, b).split("\n");
    const allCommented = lines.every((l) => l.trim() === "" || /^\s*\/\//.test(l));
    const changed = lines.map((l) => {
      if (l.trim() === "") return l;
      if (allCommented) return l.replace(/^(\s*)\/\/ ?/, "$1");
      return l.replace(/^(\s*)/, "$1// ");
    });
    const text = changed.join("\n");
    const delta = text.length - (b - a);
    return { value: value.slice(0, a) + text + value.slice(b), start: Math.max(a, start + (changed[0].length - lines[0].length)), end: end + delta };
  }

  if (key === "Tab") {
    const multi = hasSel && value.slice(start, end).includes("\n");
    if (!multi && !mods.shift) return { value: value.slice(0, start) + "  " + value.slice(end), start: start + 2, end: start + 2 };
    const a = lineStart(value, start);
    let b = value.indexOf("\n", end); if (b === -1) b = value.length;
    const lines = value.slice(a, b).split("\n");
    const changed = lines.map((l) => (mods.shift ? l.replace(/^ {1,2}/, "") : "  " + l));
    const text = changed.join("\n");
    const firstDelta = changed[0].length - lines[0].length;
    return { value: value.slice(0, a) + text + value.slice(b), start: Math.max(a, start + firstDelta), end: end + (text.length - (b - a)) };
  }

  if (key === "Enter" && !mods.shift && !mods.mod) {
    const a = lineStart(value, start);
    const indent = /^[ \t]*/.exec(value.slice(a, start))[0];
    const opens = prev === "{" || prev === "(" || prev === "[";
    if (opens && CLOSERS.has(next)) {
      const ins = "\n" + indent + "  " + "\n" + indent;
      return { value: value.slice(0, start) + ins + value.slice(end), start: start + 1 + indent.length + 2, end: start + 1 + indent.length + 2 };
    }
    const ins = "\n" + indent + (opens ? "  " : "");
    return { value: value.slice(0, start) + ins + value.slice(end), start: start + ins.length, end: start + ins.length };
  }

  if (key === "Backspace" && !hasSel && prev && OPEN[prev] === next && next !== "") {
    return { value: value.slice(0, start - 1) + value.slice(end + 1), start: start - 1, end: start - 1 };
  }

  if (CLOSERS.has(key) && !hasSel && next === key) return { value, start: start + 1, end: start + 1 };

  if (key in OPEN && !mods.mod) {
    const close = OPEN[key];
    const isQuote = key === '"' || key === "'";
    if (hasSel) return { value: value.slice(0, start) + key + value.slice(start, end) + close + value.slice(end), start: start + 1, end: end + 1 };
    if (isQuote && next === key) return { value, start: start + 1, end: start + 1 };
    if (isQuote && /[A-Za-z0-9_$]/.test(prev)) return null; // an apostrophe inside a word
    if (next === "" || /\s/.test(next) || CLOSERS.has(next)) return { value: value.slice(0, start) + key + close + value.slice(end), start: start + 1, end: start + 1 };
  }
  return null;
}
