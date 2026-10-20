import test from "node:test";
import assert from "node:assert/strict";
import { MIN_LENGTH, assessPassword, emailProblem } from "./password.js";

test("the only required rule is the server's: 12 characters", () => {
  assert.equal(MIN_LENGTH, 12);
  assert.equal(assessPassword("a".repeat(11)).meetsRequired, false);
  assert.equal(assessPassword("a".repeat(12)).meetsRequired, true);
  assert.equal(assessPassword("a".repeat(200)).meetsRequired, true);
  assert.equal(assessPassword("a".repeat(201)).meetsRequired, false, "the server rejects more than 200");
  assert.match(assessPassword("a".repeat(201)).tip, /at most 200/);
});

test("too short is its own level and says how many characters remain", () => {
  const a = assessPassword("hello");
  assert.equal(a.level, 0);
  assert.equal(a.label, "Too short");
  assert.match(a.tip, /7 more characters/);
  assert.match(assessPassword("a".repeat(11)).tip, /1 more character to go/);
  assert.equal(assessPassword("").level, 0);
  assert.match(assessPassword("").tip, /Longer is stronger/);
});

test("repetition and sequences are weak even when long enough", () => {
  assert.equal(assessPassword("aaaaaaaaaaaa").level, 1);
  assert.equal(assessPassword("abcdefghijkl").level <= 1, true, "a pure sequence");
  assert.equal(assessPassword("123456789012").level <= 1, true);
});

test("common words and the user's own email cap the level at Weak", () => {
  const p = assessPassword("MyPassword!2026xyz");
  assert.equal(p.level, 1);
  assert.equal(p.checks.find((c) => c.id === "common").ok, false);
  assert.match(p.tip, /Avoid common words/);
  const e = assessPassword("Giraffe-chris-Tuesday-77!", "chris@example.com");
  assert.equal(e.level, 1, "contains the email name");
  assert.equal(assessPassword("Giraffe-river-Tuesday-77!", "chris@example.com").level >= 3, true);
});

test("strength rises with length and variety", () => {
  const levels = ["lowercaseonly", "Lowercase1only", "Tr0ub4dor&Xq9!", "correct horse battery staple"].map((p) => assessPassword(p).level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), "monotonic for these samples");
  assert.equal(assessPassword("correct horse battery staple").level, 4, "a long passphrase is excellent");
  assert.ok(assessPassword("correct horse battery staple").bits >= 80);
});

test("optional checks report independently and never block", () => {
  const p = assessPassword("alllowercaseletters");
  const by = Object.fromEntries(p.checks.map((c) => [c.id, c]));
  assert.equal(by.length.required, true);
  assert.equal(by.length.ok, true);
  for (const id of ["case", "number", "symbol"]) { assert.equal(by[id].required, false); assert.equal(by[id].ok, false); }
  assert.equal(p.meetsRequired, true, "advice does not block sign-up");
  assert.match(p.tip, /would make it stronger/);
});

test("email checks: helpful messages, no false rejections of ordinary addresses", () => {
  assert.match(emailProblem(""), /Enter your email/);
  assert.match(emailProblem("chris"), /missing @/);
  assert.match(emailProblem("chris@host"), /domain/);
  assert.match(emailProblem("a b@x.dev"), /doesn't look like/);
  assert.match(emailProblem("x".repeat(250) + "@a.dev"), /too long/);
  for (const ok of ["you@company.dev", "first.last+tag@sub.example.co.uk", "  spaced@example.com  "]) assert.equal(emailProblem(ok), null, ok);
});
