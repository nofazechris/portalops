import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { makeTestStore } from "../../packages/database/testing.ts";
import { MemorySender } from "../../packages/email/index.ts";
import { createApp, type AppConfig } from "./app.ts";
import { RateLimiter } from "./http.ts";
import { hashToken } from "./auth.ts";

// Email verification, password reset and GitHub sign-in, through the REAL API over HTTP.

const PASSWORD = "correct horse battery staple";
const PUBLIC = "https://app.example.test";

interface GhMock { profile: { id: number; login: string } | null; emails: { email: string; primary: boolean; verified: boolean }[] | null; tokenOk: boolean; calls: string[] }

async function start(over: Partial<AppConfig> = {}, limits: Record<string, RateLimiter> = {}) {
  const store = await makeTestStore();
  const sender = new MemorySender();
  const gh: GhMock = { profile: { id: 1001, login: "octocat" }, emails: [{ email: "octo@example.com", primary: true, verified: true }], tokenOk: true, calls: [] };
  const ghFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    gh.calls.push(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://github.com/login/oauth/access_token")) return gh.tokenOk ? json({ access_token: "gho_testtoken" }) : json({ error: "bad_verification_code" });
    if (url === "https://api.github.com/user") return gh.profile ? json(gh.profile) : json({}, 401);
    if (url === "https://api.github.com/user/emails") return gh.emails ? json(gh.emails) : json({}, 401);
    void init;
    return json({}, 404);
  };
  const config: AppConfig = {
    networkId: "portaldot-v3-testnet", networkLabel: "Portaldot V3.0 Testnet", chainId: 420420777, encryptionKey: randomBytes(32), allowedOrigins: [], cookieSecure: true,
    sessionTtlMs: 3_600_000, allowPrivateWebhookTargets: false, maxProjectsPerUser: 5, receiverBaseUrl: null,
    publicUrl: PUBLIC, email: sender, github: { clientId: "client-123", clientSecret: "secret-456" }, fetch: ghFetch, ...over,
  };
  const handler = createApp({
    store, config,
    network: { check: async () => ({ chainIdVerified: true, reportedChainId: 420420777, headBlock: 1, latencyMs: 1, error: null }), getCode: async () => "0x" },
    rateLimits: { auth: new RateLimiter(1000, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000), ...limits },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  /** A browser-ish client with its own cookie jar. */
  const client = () => {
    const jar = new Map<string, string>();
    const absorb = (res: Response) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === "" || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await fetch(base + path, { method, redirect: "manual", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar.size ? { cookie: cookie() } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      absorb(res);
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, data: json?.data, error: json?.error, headers: res.headers, location: res.headers.get("location"), setCookies: res.headers.getSetCookie() };
    };
    return { call, jar };
  };
  return { base, store, sender, gh, client, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const tokenFrom = (link: string | null, kind: "verify" | "reset") => {
  assert.ok(link, "an email with a link was sent");
  const m = new RegExp(`^${PUBLIC.replace(/[.]/g, "\\.")}/auth#${kind}=([A-Za-z0-9_-]{20,})$`).exec(link!);
  assert.ok(m, `link looks like ${PUBLIC}/auth#${kind}=…  (got ${link})`);
  return m![1];
};
const until = async (cond: () => boolean, ms = 2000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10)); };

// ------------------------------------------------------------------------------------------------ email verification
test("signup: a verification email with a fragment link is sent, the account starts unverified, and the link works exactly once", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  const su = await c.call("POST", "/api/v1/auth/signup", { email: "Ada@Example.com", password: PASSWORD });
  assert.equal(su.status, 201);
  assert.equal(su.data.user.emailVerified, false);
  assert.equal(su.data.user.hasPassword, true);
  assert.ok(!JSON.stringify(su.data).includes("passwordHash") && !JSON.stringify(su.data).includes("scrypt"));

  assert.equal(a.sender.sent.length, 1);
  assert.equal(a.sender.sent[0].to, "ada@example.com");
  assert.ok(!a.sender.sent[0].html.includes("<script"));
  const token = tokenFrom(a.sender.lastLink("ada@example.com"), "verify");
  assert.ok(!a.sender.sent[0].text.includes("?token="), "the token is in the URL fragment, never the query string");

  assert.equal((await c.call("GET", "/api/v1/auth/me")).data.user.emailVerified, false);
  // verification does not need the session: it works from any browser that has the link
  const other = a.client();
  assert.equal((await other.call("POST", "/api/v1/auth/verify-email", { token })).data.verified, true);
  assert.equal((await c.call("GET", "/api/v1/auth/me")).data.user.emailVerified, true);

  const again = await other.call("POST", "/api/v1/auth/verify-email", { token });
  assert.equal(again.status, 400);
  assert.equal(again.error.code, "invalid_token");
  assert.equal((await other.call("POST", "/api/v1/auth/verify-email", { token: "x".repeat(40) })).error.code, "invalid_token");
  assert.equal((await other.call("POST", "/api/v1/auth/verify-email", { token: "short" })).status, 422);
});

test("verification tokens: stored only as a hash, expire, and a reset token cannot verify an address", async (t) => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const a = await start({ now: () => new Date(clock) }); t.after(() => a.close());
  const c = a.client();
  await c.call("POST", "/api/v1/auth/signup", { email: "ttl@example.com", password: PASSWORD });
  const token = tokenFrom(a.sender.lastLink("ttl@example.com"), "verify");

  const rows = await a.store.rawAll("SELECT token_hash, kind FROM auth_tokens");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashToken(token));
  assert.notEqual(rows[0].token_hash, token, "the raw token is never stored");

  await c.call("POST", "/api/v1/auth/forgot-password", { email: "ttl@example.com" });
  await until(() => a.sender.sent.length === 2);
  const resetToken = tokenFrom(a.sender.lastLink("ttl@example.com"), "reset");
  assert.equal((await c.call("POST", "/api/v1/auth/verify-email", { token: resetToken })).error.code, "invalid_token", "wrong kind");

  clock += 25 * 3600 * 1000; // past the 24 h verification window
  assert.equal((await c.call("POST", "/api/v1/auth/verify-email", { token })).error.code, "invalid_token", "expired");
});

test("resend-verification: needs a session, supersedes the old link, is rate limited, and reports a provider failure honestly", async (t) => {
  let clock = Date.now();
  const a = await start({ now: () => new Date(clock) }); t.after(() => a.close());
  const anon = a.client();
  assert.equal((await anon.call("POST", "/api/v1/auth/resend-verification", {})).status, 401);

  const c = a.client();
  await c.call("POST", "/api/v1/auth/signup", { email: "re@example.com", password: PASSWORD });
  const first = tokenFrom(a.sender.lastLink("re@example.com"), "verify");

  const r1 = await c.call("POST", "/api/v1/auth/resend-verification", {});
  assert.equal(r1.data.sent, true);
  const second = tokenFrom(a.sender.lastLink("re@example.com"), "verify");
  assert.notEqual(first, second);
  assert.equal((await anon.call("POST", "/api/v1/auth/verify-email", { token: first })).error.code, "invalid_token", "only the newest link works");

  const r2 = await c.call("POST", "/api/v1/auth/resend-verification", {});
  assert.equal(r2.status, 429, "one per minute");
  assert.ok(Number(r2.headers.get("retry-after")) > 0);

  assert.equal((await anon.call("POST", "/api/v1/auth/verify-email", { token: second })).data.verified, true);
  assert.deepEqual((await c.call("POST", "/api/v1/auth/resend-verification", {})).data, { sent: false, alreadyVerified: true });

  const f = await start({ now: () => new Date(clock) }); t.after(() => f.close());
  f.sender.failWith = "Resend 403: You can only send testing emails to your own email address";
  const fc = f.client();
  const su = await fc.call("POST", "/api/v1/auth/signup", { email: "fail@example.com", password: PASSWORD });
  assert.equal(su.status, 201, "sign-up never fails because email could not be sent");
  clock += 61_000;
  const rf = await fc.call("POST", "/api/v1/auth/resend-verification", {});
  assert.equal(rf.status, 503);
  assert.equal(rf.error.code, "email_unavailable");
});

// ------------------------------------------------------------------------------------------------ password reset
test("forgot-password: identical answer for known and unknown addresses; the email goes only to the real account", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  await c.call("POST", "/api/v1/auth/signup", { email: "real@example.com", password: PASSWORD });
  a.sender.sent.length = 0;

  const known = await c.call("POST", "/api/v1/auth/forgot-password", { email: "real@example.com" });
  const unknown = await c.call("POST", "/api/v1/auth/forgot-password", { email: "nobody@example.com" });
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, unknown.data, "same body: no account enumeration");
  assert.equal(known.status, unknown.status);

  await until(() => a.sender.sent.length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.sender.sent.length, 1);
  assert.equal(a.sender.sent[0].to, "real@example.com");
  assert.equal((await c.call("POST", "/api/v1/auth/forgot-password", { email: "not-an-email" })).status, 422);
});

test("forgot-password: rate limited per address and per client", async (t) => {
  const a = await start({}, { auth: new RateLimiter(3, 60_000) }); t.after(() => a.close());
  const c = a.client();
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await c.call("POST", "/api/v1/auth/forgot-password", { email: "same@example.com" })).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.ok(codes.slice(3).every((x) => x === 429), `limited after the budget: ${codes}`);
});

test("reset-password: sets the new password, signs out every session, works once, and proves email ownership", async (t) => {
  const a = await start(); t.after(() => a.close());
  const victim = a.client();
  await victim.call("POST", "/api/v1/auth/signup", { email: "reset@example.com", password: PASSWORD });
  assert.equal((await victim.call("GET", "/api/v1/auth/me")).status, 200);
  assert.equal((await victim.call("GET", "/api/v1/auth/me")).data.user.emailVerified, false);

  a.sender.sent.length = 0;
  await a.client().call("POST", "/api/v1/auth/forgot-password", { email: "reset@example.com" });
  await until(() => a.sender.sent.length === 1);
  const token = tokenFrom(a.sender.lastLink("reset@example.com"), "reset");

  const anon = a.client();
  assert.equal((await anon.call("POST", "/api/v1/auth/reset-password", { token, password: "short" })).status, 422, "weak password rejected and the token is NOT spent");
  const NEW = "a brand new passphrase 2026";
  assert.equal((await anon.call("POST", "/api/v1/auth/reset-password", { token, password: NEW })).data.reset, true);

  assert.equal((await victim.call("GET", "/api/v1/auth/me")).status, 401, "the old session is revoked");
  assert.equal((await anon.call("POST", "/api/v1/auth/login", { email: "reset@example.com", password: PASSWORD })).status, 401, "old password no longer works");
  const login = await anon.call("POST", "/api/v1/auth/login", { email: "reset@example.com", password: NEW });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.emailVerified, true, "clicking the reset link proved they own the inbox");

  assert.equal((await anon.call("POST", "/api/v1/auth/reset-password", { token, password: NEW + "x" })).error.code, "invalid_token", "single use");
});

test("reset-password: a newer link replaces the older one, and unknown or expired tokens are refused", async (t) => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const a = await start({ now: () => new Date(clock) }, { auth: new RateLimiter(1000, 60_000) }); t.after(() => a.close());
  const c = a.client();
  await c.call("POST", "/api/v1/auth/signup", { email: "two@example.com", password: PASSWORD });
  a.sender.sent.length = 0;
  await c.call("POST", "/api/v1/auth/forgot-password", { email: "two@example.com" });
  await until(() => a.sender.sent.length === 1);
  const t1 = tokenFrom(a.sender.lastLink("two@example.com"), "reset");
  await c.call("POST", "/api/v1/auth/forgot-password", { email: "two@example.com" });
  await until(() => a.sender.sent.length === 2);
  const t2 = tokenFrom(a.sender.lastLink("two@example.com"), "reset");
  assert.equal((await c.call("POST", "/api/v1/auth/reset-password", { token: t1, password: PASSWORD + "!" })).error.code, "invalid_token");
  clock += 61 * 60_000; // past the 1 h window
  assert.equal((await c.call("POST", "/api/v1/auth/reset-password", { token: t2, password: PASSWORD + "!" })).error.code, "invalid_token");
  assert.equal((await c.call("POST", "/api/v1/auth/reset-password", { token: "z".repeat(43), password: PASSWORD })).error.code, "invalid_token");
});

// ------------------------------------------------------------------------------------------------ GitHub
const startGithub = async (c: ReturnType<Awaited<ReturnType<typeof start>>["client"]>) => {
  const r = await c.call("GET", "/api/v1/auth/github/start");
  const url = new URL(r.location!);
  return { r, state: url.searchParams.get("state")!, url };
};

test("github start: redirects to GitHub with a fresh state, the exact callback URL and a short-lived Lax cookie", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  const { r, state, url } = await startGithub(c);
  assert.equal(r.status, 302);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), `${PUBLIC}/api/v1/auth/github/callback`);
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.ok(state.length >= 30);
  assert.ok(!r.location!.includes("secret-456"), "the client secret is never sent through the browser");
  const cookie = r.setCookies.find((x) => x.startsWith("portalops_oauth="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=600/);
  assert.match(cookie, /Path=\/api\/v1\/auth\/github/);
  const second = await startGithub(a.client());
  assert.notEqual(second.state, state, "every attempt has its own state");
});

test("github: not configured means hidden and unavailable", async (t) => {
  const a = await start({ github: null }); t.after(() => a.close());
  const c = a.client();
  assert.equal((await c.call("GET", "/api/v1/auth/providers")).data.github, false);
  assert.equal((await c.call("GET", "/api/v1/auth/github/start")).status, 404);
  const cb = await c.call("GET", "/api/v1/auth/github/callback?code=x&state=y");
  assert.equal(cb.status, 302);
  assert.match(cb.location!, /#error=github_unavailable$/);
  const on = await start(); t.after(() => on.close());
  assert.equal((await on.client().call("GET", "/api/v1/auth/providers")).data.github, true);
});

test("github callback: a new GitHub user gets a verified account and a session, with no password", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  const { state } = await startGithub(c);
  const cb = await c.call("GET", `/api/v1/auth/github/callback?code=abc123&state=${state}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.location, `${PUBLIC}/app`);
  assert.ok(cb.setCookies.some((x) => x.startsWith("portalops_session=") && /HttpOnly/.test(x)));
  assert.ok(cb.setCookies.some((x) => x.startsWith("portalops_oauth=") && /Max-Age=0/.test(x)), "the state cookie is spent");

  const me = (await c.call("GET", "/api/v1/auth/me")).data.user;
  assert.equal(me.email, "octo@example.com");
  assert.equal(me.emailVerified, true);
  assert.equal(me.githubLinked, true);
  assert.equal(me.githubLogin, "octocat");
  assert.equal(me.hasPassword, false);
  assert.ok(a.gh.calls.includes("https://github.com/login/oauth/access_token"));

  // a GitHub-only account cannot be signed into with any password, and does not look different from a wrong password
  const anon = a.client();
  const bad = await anon.call("POST", "/api/v1/auth/login", { email: "octo@example.com", password: "!oauth" });
  const nobody = await anon.call("POST", "/api/v1/auth/login", { email: "nobody@example.com", password: "!oauth" });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.error, nobody.error);

  // signing in again with the same GitHub account reuses it
  const c2 = a.client();
  const s2 = await startGithub(c2);
  await c2.call("GET", `/api/v1/auth/github/callback?code=def&state=${s2.state}`);
  assert.equal((await c2.call("GET", "/api/v1/auth/me")).data.user.id, me.id);
  assert.equal(Number((await a.store.rawAll("SELECT COUNT(*) AS n FROM users"))[0].n), 1);
});

test("github callback: an existing verified account with the same email is linked, not duplicated", async (t) => {
  const a = await start(); t.after(() => a.close());
  const mine = a.client();
  await mine.call("POST", "/api/v1/auth/signup", { email: "octo@example.com", password: PASSWORD });
  const token = tokenFrom(a.sender.lastLink("octo@example.com"), "verify");
  await mine.call("POST", "/api/v1/auth/verify-email", { token });

  const c = a.client();
  const { state } = await startGithub(c);
  await c.call("GET", `/api/v1/auth/github/callback?code=ok&state=${state}`);
  const me = (await c.call("GET", "/api/v1/auth/me")).data.user;
  assert.equal(me.githubLinked, true);
  assert.equal(me.hasPassword, true, "their password still works");
  assert.equal((await a.client().call("POST", "/api/v1/auth/login", { email: "octo@example.com", password: PASSWORD })).status, 200);
  assert.equal(Number((await a.store.rawAll("SELECT COUNT(*) AS n FROM users"))[0].n), 1);
});

test("github callback: an UNVERIFIED account with that email is reclaimed (the pre-registration takeover is closed)", async (t) => {
  const a = await start(); t.after(() => a.close());
  const attacker = a.client();
  await attacker.call("POST", "/api/v1/auth/signup", { email: "octo@example.com", password: "attacker knows this one 1" }); // never verified
  assert.equal((await attacker.call("GET", "/api/v1/auth/me")).status, 200);

  const owner = a.client();
  const { state } = await startGithub(owner);
  await owner.call("GET", `/api/v1/auth/github/callback?code=ok&state=${state}`);
  const me = (await owner.call("GET", "/api/v1/auth/me")).data.user;
  assert.equal(me.emailVerified, true);
  assert.equal(me.githubLinked, true);
  assert.equal(me.hasPassword, false, "the attacker's password was discarded");

  assert.equal((await attacker.call("GET", "/api/v1/auth/me")).status, 401, "the attacker's session is revoked");
  assert.equal((await a.client().call("POST", "/api/v1/auth/login", { email: "octo@example.com", password: "attacker knows this one 1" })).status, 401);
});

test("github callback: a returning GitHub id wins even if the email changed; a different GitHub id on a linked address is refused", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  let s = await startGithub(c);
  await c.call("GET", `/api/v1/auth/github/callback?code=1&state=${s.state}`);
  const id = (await c.call("GET", "/api/v1/auth/me")).data.user.id;

  a.gh.emails = [{ email: "new-address@example.com", primary: true, verified: true }]; // same GitHub id, new email
  const c2 = a.client();
  s = await startGithub(c2);
  await c2.call("GET", `/api/v1/auth/github/callback?code=2&state=${s.state}`);
  assert.equal((await c2.call("GET", "/api/v1/auth/me")).data.user.id, id);

  a.gh.profile = { id: 9999, login: "someone-else" }; // a different GitHub account claiming the first account's address
  a.gh.emails = [{ email: "octo@example.com", primary: true, verified: true }];
  const c3 = a.client();
  s = await startGithub(c3);
  const cb = await c3.call("GET", `/api/v1/auth/github/callback?code=3&state=${s.state}`);
  assert.match(cb.location!, /#error=github_account_mismatch$/);
  assert.equal((await c3.call("GET", "/api/v1/auth/me")).status, 401);
});

test("github callback: forged, replayed, missing-state and failure cases all end on the sign-in page with an error and no session", async (t) => {
  const a = await start(); t.after(() => a.close());
  const errorOf = async (setup: (c: ReturnType<typeof a.client>) => Promise<string>, tweak?: () => void) => {
    const c = a.client();
    tweak?.();
    const path = await setup(c);
    const cb = await c.call("GET", path);
    assert.equal(cb.status, 302);
    assert.ok(cb.location!.startsWith(`${PUBLIC}/auth#error=`), cb.location!);
    assert.ok(!cb.setCookies.some((x) => x.startsWith("portalops_session=") && !/Max-Age=0/.test(x)), "no session");
    assert.equal((await c.call("GET", "/api/v1/auth/me")).status, 401);
    return cb.location!.split("#error=")[1];
  };

  // no cookie at all (callback opened by someone who never started)
  assert.equal(await errorOf(async () => "/api/v1/auth/github/callback?code=x&state=forged"), "state_mismatch");
  // a valid cookie but a different state in the URL (CSRF: an attacker's link)
  assert.equal(await errorOf(async (c) => { await startGithub(c); return "/api/v1/auth/github/callback?code=x&state=attacker-chosen-state"; }), "state_mismatch");
  // the state cookie is single use
  {
    const c = a.client();
    const { state } = await startGithub(c);
    await c.call("GET", `/api/v1/auth/github/callback?code=1&state=${state}`);
    const replay = await a.client().call("GET", `/api/v1/auth/github/callback?code=1&state=${state}`);
    assert.match(replay.location!, /#error=state_mismatch$/);
  }
  // the user pressed Cancel on GitHub
  assert.equal(await errorOf(async (c) => { const { state } = await startGithub(c); return `/api/v1/auth/github/callback?error=access_denied&state=${state}`; }), "access_denied");
  // GitHub rejects the code
  assert.equal(await errorOf(async (c) => { const { state } = await startGithub(c); return `/api/v1/auth/github/callback?code=bad&state=${state}`; }, () => { a.gh.tokenOk = false; }), "github_failed");
  a.gh.tokenOk = true;
  // no verified email on the GitHub account
  assert.equal(await errorOf(async (c) => { const { state } = await startGithub(c); return `/api/v1/auth/github/callback?code=ok&state=${state}`; }, () => { a.gh.emails = [{ email: "unverified@example.com", primary: true, verified: false }]; }), "github_no_verified_email");
  // GitHub's profile call fails
  assert.equal(await errorOf(async (c) => { const { state } = await startGithub(c); return `/api/v1/auth/github/callback?code=ok&state=${state}`; }, () => { a.gh.emails = [{ email: "x@example.com", primary: true, verified: true }]; a.gh.profile = null; }), "github_failed");
  assert.equal(Number((await a.store.rawAll("SELECT COUNT(*) AS n FROM users"))[0].n), 1, "only the one legitimate sign-in above created an account; no failed attempt created any");
});

test("github callback: uses the primary verified address, falling back to any verified one", async (t) => {
  const a = await start(); t.after(() => a.close());
  a.gh.emails = [
    { email: "secondary@example.com", primary: false, verified: true },
    { email: "primary-unverified@example.com", primary: true, verified: false },
  ];
  const c = a.client();
  const { state } = await startGithub(c);
  await c.call("GET", `/api/v1/auth/github/callback?code=ok&state=${state}`);
  assert.equal((await c.call("GET", "/api/v1/auth/me")).data.user.email, "secondary@example.com");
});

test("the oauth state cookie is scoped to the GitHub routes only", async (t) => {
  const a = await start(); t.after(() => a.close());
  const c = a.client();
  await startGithub(c);
  // the cookie is not sent to other API routes (it is Path-scoped); the jar here does not model paths, so check the attribute instead
  const r = await a.client().call("GET", "/api/v1/auth/github/start");
  assert.ok(r.setCookies.every((x) => !x.startsWith("portalops_oauth=") || /Path=\/api\/v1\/auth\/github/.test(x)));
});
