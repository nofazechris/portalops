import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// scrypt cost: N=2^16, r=8, p=1 (64 MiB, ~150 ms). OWASP's minimum is N=2^17; 2^16 keeps small hosts responsive. Parameters are stored
// in each hash, so raising N later is transparent: old hashes keep verifying with their own parameters.
const N = 65_536, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;
const OPTS = { N, r: R, p: P, maxmem: MAXMEM };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, OPTS);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  // Parameters come from the database, which we trust, but never let a corrupted or planted row request unbounded memory.
  if (!(Number(n) >= 2 ** 14 && Number(n) <= 2 ** 18 && Number(r) >= 1 && Number(r) <= 16 && Number(p) >= 1 && Number(p) <= 4)) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verified against when the account does not exist, so unknown emails cost the same time as wrong passwords. */
let dummy: Promise<string> | undefined;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword("not-a-real-password-" + randomBytes(8).toString("hex")));

export const SESSION_COOKIE = "portalops_session";

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export const clearedSessionCookie = (secure: boolean): string => sessionCookie("", 0, secure);
