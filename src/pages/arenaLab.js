// Arena Lab: five coding challenges built on the Arena game contract's events. A visitor writes the handler a game backend needs,
// runs it against test cases, and sees which fail and why, the way a coding-challenge site works. Everything here is pure data and
// pure functions so it can be tested without a browser: GRADER_SOURCE is self-contained JavaScript that runs in a Web Worker in the
// page (so an endless loop cannot freeze the tab) and, identically, under node:test.
//
// The rules the challenges teach are PortalOps' real ones (packages/webhook-engine): the signature format, the 300 s tolerance, which
// statuses are retried, the 5 attempts and the 5 s base / 1 h cap backoff, and that a replay re-sends the same event id.

export const EVENT_SHAPE = `{
  id: "evt_1",                       // stable: a retry or replay sends the same id
  type: "event.received",
  data: {
    eventName: "BattleResolved",
    payload: { battleId: "1", winner: "0xA1", loser: "0xB2", xpGained: "40" },   // big numbers arrive as strings
    finalityStatus: "included"       // included | confirmed | finalized | orphaned
  }
}`;

const STATE_RULES = [
  "state is { players: {}, loot: [], seen: {} } and your function changes it in place.",
  "PlayerJoined { player, name }: players[player] = { name, wins: 0, losses: 0, level: 1 }.",
  "BattleResolved { winner, loser }: the winner's wins goes up by 1 and the loser's losses goes up by 1.",
  "LevelUp { player, level }: set that player's level to Number(level).",
  'LootDropped { player, item }: put "<name> found a <item>" at the front of state.loot.',
];

const LEADERBOARD_STARTER = [
  "// Called once for every webhook your game receives. Change `state` in place.",
  "function handle(state, event) {",
  "  const name = event.data.eventName;",
  "  const p = event.data.payload;",
  "",
  '  if (name === "PlayerJoined") {',
  "    // TODO: add the player to state.players",
  "  }",
  '  if (name === "BattleResolved") {',
  "    // TODO: winner.wins + 1, loser.losses + 1",
  "  }",
  '  if (name === "LevelUp") {',
  "    // TODO: set the player's level",
  "  }",
  '  if (name === "LootDropped") {',
  "    // TODO: add a line to the front of state.loot",
  "  }",
  "}",
].join("\n");

const LEADERBOARD_SOLUTION = [
  "function handle(state, event) {",
  "  const name = event.data.eventName;",
  "  const p = event.data.payload;",
  "",
  '  if (name === "PlayerJoined") {',
  "    state.players[p.player] = { name: p.name, wins: 0, losses: 0, level: 1 };",
  "  }",
  '  if (name === "BattleResolved") {',
  "    state.players[p.winner].wins += 1;",
  "    state.players[p.loser].losses += 1;",
  "  }",
  '  if (name === "LevelUp") {',
  "    state.players[p.player].level = Number(p.level);",
  "  }",
  '  if (name === "LootDropped") {',
  '    state.loot.unshift(state.players[p.player].name + " found a " + p.item);',
  "  }",
  "}",
].join("\n");

const DEDUPE_STARTER = LEADERBOARD_SOLUTION.replace(
  "function handle(state, event) {\n",
  "function handle(state, event) {\n  // TODO: retries and replays send the SAME event.id again. Remember the ids you handled in state.seen\n  // and ignore an id you have already handled.\n",
);

const DEDUPE_SOLUTION = LEADERBOARD_SOLUTION.replace(
  "function handle(state, event) {\n",
  "function handle(state, event) {\n  if (state.seen[event.id]) return;\n  state.seen[event.id] = true;\n",
);

const FINALITY_STARTER = DEDUPE_SOLUTION.replace(
  "  if (state.seen[event.id]) return;\n  state.seen[event.id] = true;\n",
  "  // TODO: ignore orphaned events, and hold LootDropped until it is finalized.\n  // Careful: the same event id can arrive first as \"included\" and again, later, as \"finalized\".\n  if (state.seen[event.id]) return;\n  state.seen[event.id] = true;\n",
);

const FINALITY_SOLUTION = DEDUPE_SOLUTION.replace(
  "  if (state.seen[event.id]) return;\n  state.seen[event.id] = true;\n",
  [
    '  const status = event.data.finalityStatus;',
    '  if (status === "orphaned") return;                                          // the chain reorganised it away',
    '  if (event.data.eventName === "LootDropped" && status !== "finalized") return;  // not yet safe: wait for the finalized copy',
    "  if (state.seen[event.id]) return;",
    "  state.seen[event.id] = true;",
    "",
  ].join("\n"),
);

const VERIFY_STARTER = [
  "// Return { ok: true } for a genuine, fresh webhook, otherwise { ok: false, reason } where reason is",
  '// "malformed" (no header, or not t=<seconds>,v1=<64 hex>), "expired" (timestamp more than 300 seconds',
  '// away from nowSeconds, either direction) or "mismatch" (the signature is wrong).',
  "// The signed text is  t + '.' + rawBody  and the signature is hex(HMAC-SHA256(secret, signedText)).",
  "async function verify(secret, rawBody, header, nowSeconds) {",
  "  // hmacHex(secret, text) is provided: it returns the lowercase hex HMAC-SHA256.",
  "  // TODO",
  "  return { ok: false, reason: \"malformed\" };",
  "}",
].join("\n");

const VERIFY_SOLUTION = [
  "async function verify(secret, rawBody, header, nowSeconds) {",
  '  if (!header) return { ok: false, reason: "malformed" };',
  "  const parts = {};",
  '  for (const piece of header.split(",")) {',
  '    const i = piece.indexOf("=");',
  "    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();",
  "  }",
  "  const t = Number(parts.t);",
  "  const sig = parts.v1;",
  '  if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "malformed" };',
  '  if (Math.abs(nowSeconds - t) > 300) return { ok: false, reason: "expired" };',
  '  const expected = await hmacHex(secret, t + "." + rawBody);',
  '  return expected === sig ? { ok: true } : { ok: false, reason: "mismatch" };',
  "}",
].join("\n");

const RETRY_STARTER = [
  "// PortalOps tried to deliver an event and got `status` (a number, or null if the server never answered).",
  "// attempt is how many tries have been made so far (1 = the first one). Return:",
  '//   "delivered" | "retry" | "fail"',
  "// Rules: 2xx is delivered. Network errors (null) and 408, 425, 429 and 5xx are worth retrying,",
  "// but only up to 5 attempts. Any other status (400, 404, 3xx ...) will never succeed: fail at once.",
  "function plan(status, attempt) {",
  "  // TODO",
  '  return "fail";',
  "}",
  "",
  "// How long can PortalOps wait before attempt number (attempt + 1)? Exponential: 5 seconds at attempt 1,",
  "// doubling each time, never more than one hour. Return milliseconds.",
  "function backoffCeilingMs(attempt) {",
  "  // TODO",
  "  return 0;",
  "}",
].join("\n");

const RETRY_SOLUTION = [
  "function plan(status, attempt) {",
  '  if (status !== null && status >= 200 && status < 300) return "delivered";',
  "  const transient = status === null || status === 408 || status === 425 || status === 429 || status >= 500;",
  '  if (!transient) return "fail";',
  '  return attempt >= 5 ? "fail" : "retry";',
  "}",
  "",
  "function backoffCeilingMs(attempt) {",
  "  return Math.min(60 * 60 * 1000, 5000 * Math.pow(2, attempt - 1));",
  "}",
].join("\n");

/** The challenges, in order. `entry` names what the grader calls; `solution` is revealed after a few tries and proves the tests are satisfiable. */
export const MISSIONS = [
  {
    id: "leaderboard",
    n: 1,
    title: "Build the leaderboard",
    level: "Easy",
    summary: "Turn four Arena events into standings and a loot feed.",
    brief: [
      "Your game backend receives one webhook per Arena event. Write handle(state, event) so that after a stream of events the state is a correct leaderboard.",
    ],
    rules: STATE_RULES,
    starter: LEADERBOARD_STARTER,
    solution: LEADERBOARD_SOLUTION,
    hint: "event.data.eventName tells you which move it was; event.data.payload holds its arguments as strings.",
  },
  {
    id: "dedupe",
    n: 2,
    title: "Survive a replay",
    level: "Medium",
    summary: "The same event arrives twice. Count it once.",
    brief: [
      "Your server restarted, so PortalOps retried a delivery, and an operator replayed another. Every one of those re-sends the same event id.",
      "Make handle() safe to call twice with the same event: the first call counts it, every later one is ignored.",
    ],
    rules: ["Same rules as challenge 1, plus: remember the ids you handled in state.seen (an object keyed by event.id)."],
    starter: DEDUPE_STARTER,
    solution: DEDUPE_SOLUTION,
    hint: "Check state.seen[event.id] first; if it is set, return. Otherwise set it and carry on.",
  },
  {
    id: "finality",
    n: 3,
    title: "Wait for finality",
    level: "Hard",
    summary: "Don't hand out loot the chain might take back.",
    brief: [
      "A chain can reorganise, so an event is not final the moment you see it. Each webhook carries data.finalityStatus.",
      "Ignore orphaned events completely. Hand out loot only when the event is finalized. Everything else counts straight away.",
      "The trap: the same loot event can arrive first as included and later, again, as finalized. It must be granted exactly once, when it becomes finalized.",
    ],
    rules: ["Same rules as before. Do not mark an event as seen until you have actually acted on it."],
    starter: FINALITY_STARTER,
    solution: FINALITY_SOLUTION,
    hint: 'Return early for "orphaned". For LootDropped, return early unless the status is "finalized", before you touch state.seen.',
  },
  {
    id: "signature",
    n: 4,
    title: "Trust only PortalOps",
    level: "Hard",
    summary: "Verify the HMAC signature on a webhook.",
    brief: [
      "Anyone can POST to your endpoint. Every PortalOps delivery carries a PortalOps-Signature header, t=<unix seconds>,v1=<hex>. Implement verify() so forged, tampered and stale requests are rejected.",
    ],
    rules: [
      "Signed text: t + '.' + rawBody. Signature: hex(HMAC-SHA256(secret, signed text)).",
      "Reject a timestamp more than 300 seconds from now (in either direction): reason \"expired\".",
      'A missing or badly formed header is "malformed". A correct format with the wrong signature is "mismatch".',
    ],
    starter: VERIFY_STARTER,
    solution: VERIFY_SOLUTION,
    hint: "Parse the header into t and v1, check the format, check the age, then recompute the HMAC with hmacHex and compare.",
  },
  {
    id: "retries",
    n: 5,
    title: "Retry or give up",
    level: "Medium",
    summary: "Decide what PortalOps does after a failed delivery.",
    brief: [
      "When your server fails, PortalOps decides whether to try again. Re-implement its decision so you can predict exactly what happens to your events.",
    ],
    rules: [
      "plan(status, attempt): \"delivered\", \"retry\" or \"fail\" as described in the starter.",
      "backoffCeilingMs(attempt): 5000 ms * 2^(attempt - 1), capped at 3,600,000 ms.",
    ],
    starter: RETRY_STARTER,
    solution: RETRY_SOLUTION,
    hint: "Permanent client errors (400, 401, 404 ...) are not worth retrying. 408, 425 and 429 are the exceptions.",
  },
];

/**
 * Self-contained JavaScript: defines `async function grade(missionId, code)` and returns [{ name, pass, detail }].
 * No backticks or dollar-brace sequences inside, because it is embedded in a template string. Uses only globals (crypto.subtle).
 */
export const GRADER_SOURCE = `
function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") { const o = {}; for (const k of Object.keys(x).sort()) o[k] = canon(x[k]); return o; }
  return x;
}
function show(x) { const s = JSON.stringify(canon(x)); return s === undefined ? "undefined" : (s.length > 260 ? s.slice(0, 260) + "..." : s); }
function same(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
const enc = new TextEncoder();
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}
function ev(id, eventName, payload, finalityStatus) {
  return { id: id, type: "event.received", data: { eventName: eventName, payload: payload, finalityStatus: finalityStatus || "finalized" } };
}
const A = "0xA1", B = "0xB2";
const join = (id, who, name, fin) => ev(id, "PlayerJoined", { player: who, name: name }, fin);
const battle = (id, w, l, fin) => ev(id, "BattleResolved", { battleId: id, winner: w, loser: l, xpGained: "40" }, fin);
const lvl = (id, who, level, fin) => ev(id, "LevelUp", { player: who, level: String(level) }, fin);
const loot = (id, who, item, fin) => ev(id, "LootDropped", { player: who, itemId: id, item: item }, fin);
const ada = (w, l, lv) => ({ name: "Ada", wins: w || 0, losses: l || 0, level: lv || 1 });
const bo = (w, l, lv) => ({ name: "Bo", wins: w || 0, losses: l || 0, level: lv || 1 });

const STREAM_CASES = {
  leaderboard: [
    ["A player joins", [join("e1", A, "Ada")], { players: { [A]: ada() }, loot: [] }],
    ["A battle is won and lost", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B)], { players: { [A]: ada(1, 0), [B]: bo(0, 1) }, loot: [] }],
    ["A level up arrives as a string", [join("e1", A, "Ada"), lvl("e2", A, 3)], { players: { [A]: ada(0, 0, 3) }, loot: [] }],
    ["Loot goes to the front of the feed", [join("e1", A, "Ada"), loot("e2", A, "Healing Potion"), loot("e3", A, "Iron Sword")], { players: { [A]: ada() }, loot: ["Ada found a Iron Sword", "Ada found a Healing Potion"] }],
    ["A whole match", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B), battle("e4", B, A), battle("e5", A, B), lvl("e6", A, 2), loot("e7", A, "Healing Potion")], { players: { [A]: ada(2, 1, 2), [B]: bo(1, 2) }, loot: ["Ada found a Healing Potion"] }],
  ],
  dedupe: [
    ["The same battle delivered twice counts once", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B), battle("e3", A, B)], { players: { [A]: ada(1, 0), [B]: bo(0, 1) }, loot: [] }],
    ["A replay after a restart", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B), battle("e3", A, B), battle("e4", A, B), battle("e3", A, B)], { players: { [A]: ada(2, 0), [B]: bo(0, 2) }, loot: [] }],
    ["A repeated join does not reset the player", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B), join("e1", A, "Ada")], { players: { [A]: ada(1, 0), [B]: bo(0, 1) }, loot: [] }],
    ["Loot is announced once", [join("e1", A, "Ada"), loot("e2", A, "Iron Sword"), loot("e2", A, "Iron Sword")], { players: { [A]: ada() }, loot: ["Ada found a Iron Sword"] }],
    ["Different ids are different events", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B), battle("e4", A, B)], { players: { [A]: ada(2, 0), [B]: bo(0, 2) }, loot: [] }],
  ],
  finality: [
    ["Orphaned events are ignored", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B, "orphaned")], { players: { [A]: ada(), [B]: bo() }, loot: [] }],
    ["Loot waits for finality", [join("e1", A, "Ada"), loot("e2", A, "Iron Sword", "included")], { players: { [A]: ada() }, loot: [] }],
    ["Loot arrives once it is finalized", [join("e1", A, "Ada"), loot("e2", A, "Iron Sword", "included"), loot("e2", A, "Iron Sword", "finalized")], { players: { [A]: ada() }, loot: ["Ada found a Iron Sword"] }],
    ["A finalized loot event replayed again is still one item", [join("e1", A, "Ada"), loot("e2", A, "Iron Sword", "included"), loot("e2", A, "Iron Sword", "finalized"), loot("e2", A, "Iron Sword", "finalized")], { players: { [A]: ada() }, loot: ["Ada found a Iron Sword"] }],
    ["Battles count straight away", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B, "confirmed")], { players: { [A]: ada(1, 0), [B]: bo(0, 1) }, loot: [] }],
    ["A battle seen as included then finalized counts once", [join("e1", A, "Ada"), join("e2", B, "Bo"), battle("e3", A, B, "included"), battle("e3", A, B, "finalized")], { players: { [A]: ada(1, 0), [B]: bo(0, 1) }, loot: [] }],
  ],
};

async function gradeStream(missionId, code) {
  const out = [];
  let handle;
  try { handle = new Function(code + "\\nreturn typeof handle === 'function' ? handle : null;")(); }
  catch (e) { return [{ name: "Your code compiles", pass: false, detail: String(e && e.message || e) }]; }
  if (!handle) return [{ name: "A function named handle exists", pass: false, detail: "Define function handle(state, event) { ... }" }];
  for (const c of STREAM_CASES[missionId]) {
    const state = { players: {}, loot: [], seen: {} };
    try {
      for (const e of c[1]) await handle(state, JSON.parse(JSON.stringify(e)));
      const got = { players: state.players, loot: state.loot };
      const pass = same(got, c[2]);
      out.push({ name: c[0], pass: pass, detail: pass ? "" : "expected " + show(c[2]) + "\\n     got " + show(got) });
    } catch (e) { out.push({ name: c[0], pass: false, detail: "threw: " + String(e && e.message || e) }); }
  }
  return out;
}

async function gradeSignature(code) {
  let verify;
  try { verify = new Function("hmacHex", code + "\\nreturn typeof verify === 'function' ? verify : null;")(hmacHex); }
  catch (e) { return [{ name: "Your code compiles", pass: false, detail: String(e && e.message || e) }]; }
  if (!verify) return [{ name: "A function named verify exists", pass: false, detail: "Define async function verify(secret, rawBody, header, nowSeconds) { ... }" }];
  const secret = "whsec_demo_secret", body = '{"id":"evt_1","data":{"eventName":"LevelUp"}}', now = 1700000000;
  const hdr = async (t, b, s) => "t=" + t + ",v1=" + await hmacHex(s || secret, t + "." + (b === undefined ? body : b));
  const cases = [
    ["A genuine, fresh webhook is accepted", [secret, body, await hdr(now - 10), now], { ok: true }],
    ["A tampered body is a mismatch", [secret, body.replace("LevelUp", "LootDropped"), await hdr(now - 10), now], { ok: false, reason: "mismatch" }],
    ["The wrong secret is a mismatch", [secret, body, await hdr(now - 10, undefined, "whsec_someone_else"), now], { ok: false, reason: "mismatch" }],
    ["300 seconds old is still accepted", [secret, body, await hdr(now - 300), now], { ok: true }],
    ["301 seconds old is expired", [secret, body, await hdr(now - 301), now], { ok: false, reason: "expired" }],
    ["A timestamp far in the future is expired", [secret, body, await hdr(now + 400), now], { ok: false, reason: "expired" }],
    ["No header is malformed", [secret, body, undefined, now], { ok: false, reason: "malformed" }],
    ["Garbage is malformed", [secret, body, "hello", now], { ok: false, reason: "malformed" }],
    ["A short signature is malformed", [secret, body, "t=" + (now - 5) + ",v1=abc123", now], { ok: false, reason: "malformed" }],
  ];
  const out = [];
  for (const c of cases) {
    try {
      const got = await verify.apply(null, c[1]);
      const pass = same(got, c[2]);
      out.push({ name: c[0], pass: pass, detail: pass ? "" : "expected " + show(c[2]) + "\\n     got " + show(got) });
    } catch (e) { out.push({ name: c[0], pass: false, detail: "threw: " + String(e && e.message || e) }); }
  }
  return out;
}

async function gradeRetries(code) {
  let fns;
  try { fns = new Function(code + "\\nreturn { plan: typeof plan === 'function' ? plan : null, backoff: typeof backoffCeilingMs === 'function' ? backoffCeilingMs : null };")(); }
  catch (e) { return [{ name: "Your code compiles", pass: false, detail: String(e && e.message || e) }]; }
  const out = [];
  const plans = [
    [200, 1, "delivered"], [204, 3, "delivered"], [500, 1, "retry"], [503, 4, "retry"], [500, 5, "fail"], [429, 2, "retry"], [408, 1, "retry"], [425, 1, "retry"],
    [400, 1, "fail"], [401, 3, "fail"], [404, 1, "fail"], [301, 1, "fail"], [null, 1, "retry"], [null, 5, "fail"],
  ];
  for (const c of plans) {
    const name = "plan(" + c[0] + ", " + c[1] + ") is " + c[2];
    if (!fns.plan) { out.push({ name: name, pass: false, detail: "Define function plan(status, attempt)" }); continue; }
    try { const got = fns.plan(c[0], c[1]); out.push({ name: name, pass: got === c[2], detail: got === c[2] ? "" : "got " + show(got) }); }
    catch (e) { out.push({ name: name, pass: false, detail: "threw: " + String(e && e.message || e) }); }
  }
  for (const c of [[1, 5000], [2, 10000], [3, 20000], [5, 80000], [10, 2560000], [12, 3600000]]) {
    const name = "backoffCeilingMs(" + c[0] + ") is " + c[1];
    if (!fns.backoff) { out.push({ name: name, pass: false, detail: "Define function backoffCeilingMs(attempt)" }); continue; }
    try { const got = fns.backoff(c[0]); out.push({ name: name, pass: got === c[1], detail: got === c[1] ? "" : "got " + show(got) }); }
    catch (e) { out.push({ name: name, pass: false, detail: "threw: " + String(e && e.message || e) }); }
  }
  return out;
}

async function grade(missionId, code) {
  if (missionId === "signature") return gradeSignature(code);
  if (missionId === "retries") return gradeRetries(code);
  if (STREAM_CASES[missionId]) return gradeStream(missionId, code);
  return [{ name: "Unknown challenge", pass: false, detail: String(missionId) }];
}
`;

/** The retry rules as plain functions, used by the delivery simulator on the page (they mirror packages/webhook-engine/retry.ts). */
export const MAX_ATTEMPTS = 5;
export const isRetryableStatus = (status) => status === null || status === 408 || status === 425 || status === 429 || status >= 500;
export const backoffCeilingMs = (attempt) => Math.min(60 * 60 * 1000, 5000 * 2 ** Math.max(0, attempt - 1));
export const nextDelayMs = (attempt, random = Math.random) => Math.max(1000, Math.floor(random() * backoffCeilingMs(attempt)));

/** What the receiver in the delivery simulator answers. */
export const RECEIVER_MODES = [
  { id: "up", label: "Healthy", status: 200 },
  { id: "down", label: "Crashing (500)", status: 500 },
  { id: "timeout", label: "Not answering", status: null },
  { id: "bad", label: "Rejecting (400)", status: 400 },
];

/** Run a challenge in a Web Worker (killed after `timeoutMs`, so an endless loop cannot freeze the page). Resolves with [{ name, pass, detail }]. */
export function runInWorker(missionId, code, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let worker;
    let url;
    const done = (results) => { clearTimeout(timer); try { worker && worker.terminate(); } catch { /* already gone */ } if (url) URL.revokeObjectURL(url); resolve(results); };
    const timer = setTimeout(() => done([{ name: "Finished in time", pass: false, detail: "Your code ran for more than " + timeoutMs / 1000 + " seconds. Is there an endless loop?" }]), timeoutMs);
    try {
      // The worker can compute, not call out: network and import APIs are removed before any of your code runs.
      const src = "self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined; self.importScripts = undefined;\n" + GRADER_SOURCE +
        "\nself.onmessage = async (e) => { try { self.postMessage({ results: await grade(e.data.missionId, e.data.code) }); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };";
      url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (e) => done(e.data.results ?? [{ name: "Your code ran", pass: false, detail: e.data.error }]);
      worker.onerror = (e) => done([{ name: "Your code ran", pass: false, detail: e.message || "The code could not run." }]);
      worker.postMessage({ missionId, code });
    } catch (e) {
      done([{ name: "Your code ran", pass: false, detail: "This browser could not start the test runner: " + (e && e.message) }]);
    }
  });
}
