import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleSender, MemorySender, RESEND_TEST_SENDER, ResendSender, createEmailSender } from "./index.ts";
import { resetPasswordMessage, verifyEmailMessage } from "./templates.ts";

const KEY = "re_test_AbCdEfGh123456789";

test("resend: sends the documented request and returns the message id", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const s = new ResendSender({ apiKey: KEY, from: "PortalOps <no-reply@example.com>", fetch: async (url, init) => { seen = { url: String(url), init: init! }; return new Response(JSON.stringify({ id: "abc-123" }), { status: 200 }); } });
  const r = await s.send({ to: "a@example.com", subject: "Hi", text: "t", html: "<p>h</p>" });
  assert.deepEqual(r, { ok: true, id: "abc-123" });
  assert.equal(seen!.url, "https://api.resend.com/emails");
  assert.equal(seen!.init.method, "POST");
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { from: "PortalOps <no-reply@example.com>", to: ["a@example.com"], subject: "Hi", text: "t", html: "<p>h</p>" });
  assert.equal(seen!.init.redirect, "error", "the key is never forwarded by a redirect");
});

test("resend: provider errors come back as a short reason that never contains the key", async () => {
  const s = new ResendSender({ apiKey: KEY, from: RESEND_TEST_SENDER, fetch: async () => new Response(JSON.stringify({ message: "You can only send testing emails to your own email address", name: "validation_error" }), { status: 403 }) });
  const r = await s.send({ to: "x@example.com", subject: "s", text: "t", html: "h" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /403/);
  assert.match(r.error!, /only send testing emails/);
  assert.ok(!r.error!.includes(KEY));

  const down = new ResendSender({ apiKey: KEY, from: "a@b.co", fetch: async () => { throw Object.assign(new Error(`connect ECONNREFUSED while using ${KEY}`), { name: "TypeError" }); } });
  const d = await down.send({ to: "x@example.com", subject: "s", text: "t", html: "h" });
  assert.deepEqual(d, { ok: false, error: "Resend could not be reached" }, "an exception message (which could contain the key) is never passed on");

  const timeout = new ResendSender({ apiKey: KEY, from: "a@b.co", fetch: async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } });
  assert.deepEqual(await timeout.send({ to: "x@example.com", subject: "s", text: "t", html: "h" }), { ok: false, error: "Resend timed out" });
});

test("resend: refuses something that is not a Resend key, instead of sending it somewhere", () => {
  assert.throws(() => new ResendSender({ apiKey: "sk-not-resend", from: "a@b.co" }), /does not look like a Resend key/);
  assert.throws(() => new ResendSender({ apiKey: "", from: "a@b.co" }), /Resend key/);
});

test("sender choice: Resend when a key exists (test sender by default), console otherwise, and a bad key falls back instead of crashing", () => {
  const withKey = createEmailSender({ RESEND_API_KEY: KEY }, { production: true });
  assert.equal(withKey.kind, "resend");
  assert.equal(createEmailSender({}, { production: false }).kind, "console");
  assert.equal(createEmailSender({ RESEND_API_KEY: "  " }, { production: true }).kind, "console");
  const orig = console.error; console.error = () => {};
  try { assert.equal(createEmailSender({ RESEND_API_KEY: "nope" }, { production: true }).kind, "console"); } finally { console.error = orig; }
});

test("console sender: shows the message (with its link) in development, never in production", async () => {
  const dev: string[] = [], prod: string[] = [];
  const m = { to: "a@example.com", subject: "Reset", text: "https://x.test/auth#reset=SECRETTOKEN", html: "" };
  assert.equal((await new ConsoleSender({ showBody: true, log: (l) => dev.push(l) }).send(m)).ok, false);
  assert.ok(dev.join("\n").includes("SECRETTOKEN"));
  await new ConsoleSender({ showBody: false, log: (l) => prod.push(l) }).send(m);
  assert.ok(!prod.join("\n").includes("SECRETTOKEN") && !prod.join("\n").includes("a@example.com"), "production logs never contain the link or the address");
});

test("memory sender: records messages, can simulate a failing provider, and finds the link", async () => {
  const s = new MemorySender();
  await s.send({ to: "a@example.com", subject: "x", text: "go to https://x.test/auth#verify=abc now", html: "" });
  assert.equal(s.lastLink("a@example.com"), "https://x.test/auth#verify=abc");
  assert.equal(s.lastLink("b@example.com"), null);
  s.failWith = "down";
  assert.deepEqual(await s.send({ to: "a@example.com", subject: "y", text: "", html: "" }), { ok: false, error: "down" });
});

test("templates: the link is escaped, there are no remote images, scripts or trackers, and the text version carries the same link", () => {
  const evil = 'https://x.test/auth#verify=a"><script>alert(1)</script>';
  const m = verifyEmailMessage("a@example.com", evil, 24);
  assert.ok(!m.html.includes("<script>"), "markup in the link cannot break out");
  assert.ok(!/<img|src=|<link|<iframe/i.test(m.html));
  assert.ok(m.text.includes(evil), "plain text is not HTML");
  assert.match(m.subject, /Confirm/);
  assert.match(m.html, /24 hours/);

  const r = resetPasswordMessage("a@example.com", "https://x.test/auth#reset=tok", 60);
  assert.match(r.subject, /Reset/);
  assert.match(r.text, /https:\/\/x\.test\/auth#reset=tok/);
  assert.match(r.text, /60 minutes/);
  assert.match(r.text, /ignore this email/);
});
