// Password feedback for the sign-up form. Pure functions (no React) so they are unit-tested in password.test.js.
//
// The ONLY rule the server enforces is the length (12–200 characters, see apps/api/app.ts). Everything else here is advice, and the
// UI says so: "required" vs "makes it stronger". The strength label is a rough estimate of how hard the password is to guess,
// not a guarantee.

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 200;

const COMMON = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "123456", "abc123", "changeme", "portalops", "portaldot", "monkey", "dragon"];

export const LEVELS = [
  { level: 0, label: "Too short", tone: "bad" },
  { level: 1, label: "Weak", tone: "bad" },
  { level: 2, label: "Okay", tone: "warn" },
  { level: 3, label: "Strong", tone: "good" },
  { level: 4, label: "Excellent", tone: "good" },
];

/** Length of the longest run of consecutive characters (abcd, 4321, 7890): they look long but add almost nothing. */
function longestRun(pw) {
  let best = 1, run = 1, dir = 0;
  for (let i = 1; i < pw.length; i++) {
    const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    if ((d === 1 || d === -1) && (dir === 0 || d === dir)) { run++; dir = d; }
    else { run = d === 1 || d === -1 ? 2 : 1; dir = d === 1 || d === -1 ? d : 0; }
    best = Math.max(best, run);
  }
  return best;
}

function emailParts(email) {
  const local = String(email || "").split("@")[0].toLowerCase();
  return local.length >= 4 ? [local] : [];
}

/**
 * @returns {{ length:number, meetsRequired:boolean, level:number, label:string, tone:string, bits:number, checks:{id:string,label:string,ok:boolean,required:boolean}[], tip:string }}
 */
export function assessPassword(pw, email = "") {
  const value = String(pw ?? "");
  const len = value.length;
  const lower = value.toLowerCase();
  const weakWord = COMMON.some((w) => lower.includes(w)) || emailParts(email).some((p) => lower.includes(p));

  const checks = [
    { id: "length", label: `At least ${MIN_LENGTH} characters`, ok: len >= MIN_LENGTH && len <= MAX_LENGTH, required: true },
    { id: "case", label: "Upper and lower case letters", ok: /[a-z]/.test(value) && /[A-Z]/.test(value), required: false },
    { id: "number", label: "A number", ok: /\d/.test(value), required: false },
    { id: "symbol", label: "A symbol, like ! ? # %", ok: /[^A-Za-z0-9]/.test(value), required: false },
    { id: "common", label: "Not a common word or part of your email", ok: len > 0 && !weakWord, required: false },
  ];
  const meetsRequired = checks.find((c) => c.id === "length").ok;

  // A deliberately conservative guess-resistance estimate: characters used × how varied they are, with credit capped for
  // repetition, single-class passwords (usually words) and sequences. It is advice, not a guarantee.
  let pool = 0, classes = 0;
  if (/[a-z]/.test(value)) { pool += 26; classes++; }
  if (/[A-Z]/.test(value)) { pool += 26; classes++; }
  if (/\d/.test(value)) { pool += 10; classes++; }
  if (/[^A-Za-z0-9]/.test(value)) { pool += 33; classes++; }
  const distinct = new Set(value).size;
  const effective = Math.min(len, distinct * 2.5);
  let bits = pool ? effective * Math.log2(pool) * 0.7 : 0;
  if (classes === 1) bits *= 0.8;
  const run = longestRun(value);
  const mostlySequence = run >= Math.max(6, len / 2);
  if (run >= 4) bits -= 12;
  bits = Math.max(0, Math.round(bits));

  let level;
  if (len < MIN_LENGTH) level = 0;
  else if (bits < 30) level = 1;
  else if (bits < 50) level = 2;
  else if (bits < 65) level = 3;
  else level = 4;
  if ((weakWord || mostlySequence) && level > 1) level = 1; // a common word, your own email or a plain sequence is never "okay"

  let tip = "";
  if (len === 0) tip = "Longer is stronger: a short sentence works well.";
  else if (!meetsRequired) tip = len > MAX_LENGTH ? `Use at most ${MAX_LENGTH} characters.` : `${MIN_LENGTH - len} more character${MIN_LENGTH - len === 1 ? "" : "s"} to go.`;
  else if (weakWord) tip = "Avoid common words and anything from your email address.";
  else if (mostlySequence) tip = "Avoid runs like abcd or 1234: they are easy to guess.";
  else if (level < 4) tip = (checks.find((c) => !c.ok && !c.required && c.id !== "common")?.label ?? "Add a few more characters") + " would make it stronger.";
  else tip = "Nice. This one would take a very long time to guess.";

  return { length: len, meetsRequired, level, label: LEVELS[level].label, tone: LEVELS[level].tone, bits, checks, tip };
}

/** Practical email check for the form; the server has the final say. */
export function emailProblem(email) {
  const v = String(email ?? "").trim();
  if (!v) return "Enter your email address.";
  if (v.length > 254) return "That email address is too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return "That doesn't look like an email address. Check for a missing @ or domain.";
  return null;
}
