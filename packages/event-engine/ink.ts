import { createHash } from "node:crypto";
import type { RawInkEvent } from "../chain-adapters/native.ts";
import type { FinalityStatus, NormalizedEvent } from "../shared-types/index.ts";

// Decoding for ink! (Rust) contracts on Portaldot's native runtime. The contract's metadata file (the .contract / metadata.json that
// `cargo contract build` writes) plays the role the ABI plays for Solidity: it names the events and types their arguments.

/** The part of @polkadot/api-contract's Abi that PortalOps uses. */
export interface InkAbi {
  decodeEvent(record: unknown): { args: InkCodec[]; event: { identifier: string; args: { name: string }[] } };
}
interface InkCodec { toJSON(): unknown; toString(): string; toRawType(): string }

/** Loads ink! metadata (JSON object or string). Throws if it is not valid ink! metadata. Loaded lazily: polkadot-js is large. */
export async function loadInkAbi(metadata: unknown): Promise<InkAbi> {
  const { Abi } = await import("@polkadot/api-contract");
  return new Abi(metadata as Record<string, unknown>) as unknown as InkAbi;
}

/** Event names a piece of ink! metadata declares, without decoding anything. */
export function inkEventNames(metadata: unknown): string[] {
  const events = (metadata as { spec?: { events?: { label?: string }[] } } | null)?.spec?.events;
  return Array.isArray(events) ? events.map((e) => e.label).filter((l): l is string => typeof l === "string") : [];
}

/** True when the object looks like ink! contract metadata rather than a Solidity ABI. */
export function looksLikeInkMetadata(x: unknown): boolean {
  const o = x as { spec?: unknown; types?: unknown; source?: unknown } | null;
  return !!o && typeof o === "object" && !Array.isArray(o) && !!o.spec && Array.isArray(o.types) && !!o.source;
}

/**
 * Stable identity for a native event (PRD §10.3): project + chain (genesis hash) + block hash + position in the block. A block's events
 * have a fixed order, so the position identifies the event; the block hash means a reorganised event is a distinct one.
 */
export function inkEventId(projectId: string, genesisHash: string, blockHash: string, eventIndex: number): string {
  return "evt_" + createHash("sha256").update(`ink:${projectId}:${genesisHash.toLowerCase()}:${blockHash.toLowerCase()}:${eventIndex}`).digest("hex").slice(0, 32);
}

/** One decoded argument as plain JSON: integers as decimal strings (like the EVM path), accounts as SS58, bytes as hex. */
function plain(c: InkCodec): unknown {
  const raw = c.toRawType();
  if (/^[ui](8|16|32|64|128|256)$/.test(raw)) return c.toString();
  const j = c.toJSON();
  return j === undefined ? null : j;
}

export interface InkNormalizeContext {
  projectId: string;
  chainId: number;
  genesisHash: string;
  /** Metadata loaded with loadInkAbi, keyed by canonical contract address. Events from unknown contracts are stored undecoded. */
  abis?: Map<string, InkAbi>;
  now?: () => Date;
  finalityStatus?: FinalityStatus;
}

const ZERO_HASH = "0x" + "0".repeat(64);

export function normalizeInkEvent(raw: RawInkEvent, ctx: InkNormalizeContext): NormalizedEvent {
  const abi = ctx.abis?.get(raw.contract);
  let eventName: string | null = null;
  let payload: Record<string, unknown> | null = null;
  if (abi) {
    try {
      const bytes = Uint8Array.from(Buffer.from(raw.data.replace(/^0x/, ""), "hex"));
      const topics = raw.topics.map((t) => ({ toHex: () => t }));
      // The two shapes of an event record that the library reads (topics on the record, or as the third event field).
      const d = abi.decodeEvent({ event: { data: [raw.contract, bytes, topics] }, topics });
      eventName = d.event.identifier.split("::").pop() ?? d.event.identifier; // the library qualifies it with the module path
      payload = Object.fromEntries(d.event.args.map((a, i) => [a.name, plain(d.args[i])]));
    } catch {
      // Metadata present but this event does not match it: keep the raw bytes, mark undecoded. Never invent a name.
    }
  }
  return {
    id: inkEventId(ctx.projectId, ctx.genesisHash, raw.blockHash, raw.eventIndex),
    projectId: ctx.projectId,
    network: "portaldot-v3-testnet",
    source: "native",
    chainId: ctx.chainId,
    contractAddress: raw.contract,
    eventName,
    decoded: eventName !== null,
    topics: raw.topics.map((t) => t.toLowerCase()),
    data: raw.data,
    payload,
    transactionHash: (raw.extrinsicHash ?? ZERO_HASH).toLowerCase(),
    transactionIndex: raw.extrinsicIndex ?? 0,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash.toLowerCase(),
    eventIndex: raw.eventIndex,
    observedAt: (ctx.now ?? (() => new Date()))().toISOString(),
    processingStatus: "persisted",
    finalityStatus: ctx.finalityStatus ?? "included",
  };
}
