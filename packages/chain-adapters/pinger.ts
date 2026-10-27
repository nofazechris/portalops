import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The public playground can send a REAL transaction to the testnet on a visitor's behalf, so a judge can watch their own click travel
// click -> chain -> PortalOps -> signed webhook. This is the whole of its power, deliberately small:
//   - one dedicated throwaway key (testnet funds only), held only by the API process;
//   - one contract and one function: ping(string) on PortalPing (it can send nothing else, and no value);
//   - the note is cleaned and capped before it is encoded;
//   - callers rate-limit it per visitor and per day (see the playground route).

const PING_ABI = parseAbi(["function ping(string note) returns (uint256 seq)"]);
export const MAX_NOTE_CHARS = 60;

export interface PingSender {
  /** The sponsor wallet's address (public). */
  readonly address: string;
  /** The only contract it will ever call. */
  readonly contract: string;
  /** Sends ping(note) and returns the transaction hash as soon as the node accepts it. */
  send(note: string): Promise<{ hash: string }>;
  /** The sponsor wallet's balance in wei (18 decimals). */
  balanceWei(): Promise<bigint>;
}

const span = (from: number, to: number) => String.fromCharCode(from) + "-" + String.fromCharCode(to);
// control characters, line and paragraph separators, and the bidirectional overrides (built from code points so no raw control character sits in the source)
const UNPRINTABLE = new RegExp("[" + span(0x00, 0x1f) + span(0x7f, 0x9f) + span(0x2028, 0x2029) + span(0x202a, 0x202e) + span(0x2066, 0x2069) + "]", "g");

/** A short, printable, single-line note: control characters and line breaks removed, whitespace collapsed, capped. */
export function cleanNote(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const flat = s.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MAX_NOTE_CHARS).join("");
}

/** The calldata for ping(note): what both the sponsor wallet and a visitor's own wallet send. */
export const encodePing = (note: string): Hex => encodeFunctionData({ abi: PING_ABI, functionName: "ping", args: [note] });

export function createPingSender(o: { privateKey: string; rpcUrl: string; chainId: number; contract: string }): PingSender {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.privateKey)) throw new Error("PORTALOPS_DEMO_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.contract)) throw new Error("The ping contract must be a 0x address.");
  const account = privateKeyToAccount(o.privateKey as Hex);
  const chain = defineChain({ id: o.chainId, name: "Portaldot V3.0 Testnet", nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const transport = http(o.rpcUrl, { timeout: 20_000, retryCount: 1 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const to = o.contract as Hex;

  // One transaction at a time: the nonce comes from the node, so two overlapping sends would collide.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const run = queue.then(fn, fn); queue = run.catch(() => undefined); return run; };

  return {
    address: account.address,
    contract: to,
    balanceWei: () => pub.getBalance({ address: account.address }),
    send: (note) => serial(async () => {
      const data = encodePing(cleanNote(note));
      // Gas here is Substrate weight: always ask the node, and pad (estimates run about 10% under on pallet-revive).
      const [est, gasPrice] = await Promise.all([pub.estimateGas({ account, to, data }), pub.getGasPrice()]);
      const hash = await wallet.sendTransaction({ to, data, gas: (est * 13n) / 10n, gasPrice });
      return { hash };
    }),
  };
}
