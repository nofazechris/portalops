import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF protection for webhook targets (PRD §16).
 *
 * validateWebhookUrl() parses and policy-checks a URL, resolves DNS ONCE, rejects if ANY returned address is
 * non-public, and returns the vetted address. The sender must connect to that address (pinning), so a DNS
 * answer that changes between check and use cannot redirect traffic to an internal host. Redirects are never followed.
 */

export class BlockedTargetError extends Error {
  readonly code: "invalid_url" | "blocked_target";
  constructor(message: string, code: "invalid_url" | "blocked_target") {
    super(message);
    this.code = code;
  }
}

export interface GuardOptions {
  /** Permit loopback/private targets. For local development and the built-in test receiver only. */
  allowPrivate?: boolean;
  /** Permit plain http. Defaults to the same value as allowPrivate. */
  allowInsecureHttp?: boolean;
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const cidr4 = (base: string, bits: number) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 });
const BLOCKED_V4 = [
  cidr4("0.0.0.0", 8), cidr4("10.0.0.0", 8), cidr4("100.64.0.0", 10), cidr4("127.0.0.0", 8),
  cidr4("169.254.0.0", 16), // link-local, includes cloud metadata 169.254.169.254
  cidr4("172.16.0.0", 12), cidr4("192.0.0.0", 24), cidr4("192.0.2.0", 24), cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15), cidr4("198.51.100.0", 24), cidr4("203.0.113.0", 24), cidr4("224.0.0.0", 4), cidr4("240.0.0.0", 4),
];

/** Expands an IPv6 literal (including `::` and a dotted IPv4 tail) into its eight 16-bit groups; null if malformed. */
function parseIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True for any address a webhook must never reach. Unparseable input counts as blocked (fail closed).
 * IPv6 transition mechanisms that embed an IPv4 address (mapped, NAT64, 6to4) are judged by the embedded address;
 * mechanisms with no legitimate webhook use (Teredo, IPv4-compatible, discard, documentation, site-local) are blocked outright.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some((c) => (n & c.mask) >>> 0 === c.base);
  }
  if (family !== 6) return true;
  const g = parseIpv6(ip);
  if (!g) return true;

  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5)) {
    if (g[5] === 0xffff) return isBlockedAddress(v4From(g[6], g[7])); // ::ffff:a.b.c.d (IPv4-mapped)
    return true; // ::, ::1 and IPv4-compatible ::a.b.c.d (deprecated)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && zeros(2, 6)) return isBlockedAddress(v4From(g[6], g[7])); // 64:ff9b::/96 NAT64
    return true; // 64:ff9b:1::/48 local-use NAT64
  }
  if (g[0] === 0x2002) return isBlockedAddress(v4From(g[1], g[2])); // 6to4 embeds the IPv4 in groups 1-2
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || g[1] <= 0x1ff)) return true; // Teredo, IETF protocol assignments, documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard-only
  if ((g[0] & 0xfff0) === 0x3ff0 && g[0] === 0x3fff) return true; // 3fff::/20 documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export interface VettedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export async function validateWebhookUrl(raw: string, opts: GuardOptions = {}): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("Not a valid URL.", "invalid_url");
  }
  const allowPrivate = opts.allowPrivate === true;
  const allowHttp = opts.allowInsecureHttp ?? allowPrivate;

  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) {
    throw new BlockedTargetError(`Scheme ${url.protocol} is not allowed${url.protocol === "http:" ? " (https required)" : ""}.`, "invalid_url");
  }
  if (url.username || url.password) throw new BlockedTargetError("Credentials in the URL are not allowed.", "invalid_url");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await (opts.resolver ?? ((h) => lookup(h, { all: true })))(host).catch(() => {
        throw new BlockedTargetError(`Could not resolve ${host}.`, "invalid_url");
      });
  if (!answers.length) throw new BlockedTargetError(`Could not resolve ${host}.`, "invalid_url");

  if (!allowPrivate) {
    const bad = answers.find((a) => isBlockedAddress(a.address));
    if (bad) throw new BlockedTargetError(`Target resolves to a non-public address (${bad.address}).`, "blocked_target");
  }
  const chosen = answers[0];
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
