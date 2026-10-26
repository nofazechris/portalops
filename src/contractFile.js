// Reads the file a developer drops on the "register contract" form and works out what it is, so they never have to say.
//   Solidity:  a bare ABI array, or a compiler artifact (Hardhat, Foundry, Remix) that has an "abi" field
//   ink! (Rust): the metadata file cargo-contract writes (metadata.json, or the bundled .contract file, which also holds the contract
//                code; the code is not needed and is dropped so the upload stays small)

/** Names of the events a Solidity ABI declares. */
const abiEvents = (abi) => abi.filter((x) => x && x.type === "event" && typeof x.name === "string").map((x) => x.name);

/** Names of the events ink! metadata declares. */
const inkEvents = (m) => (Array.isArray(m?.spec?.events) ? m.spec.events.map((e) => e.label).filter((l) => typeof l === "string") : []);

const isInk = (v) => !!v && typeof v === "object" && !Array.isArray(v) && !!v.spec && Array.isArray(v.types) && !!v.source;

/**
 * @returns {{ kind: "evm" | "ink", abi: unknown, events: string[], note?: string }}
 * @throws {Error} with a message that says what to do, when the text is not something PortalOps can use
 */
export function detectContractFile(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("That file is empty.");
  let v;
  try { v = JSON.parse(trimmed); } catch { throw new Error("That is not valid JSON. Use the ABI, the compiler artifact, or the ink! metadata file."); }

  if (Array.isArray(v)) {
    if (!v.length || !v.every((x) => x && typeof x === "object")) throw new Error("That array is not a Solidity ABI.");
    return { kind: "evm", abi: v, events: abiEvents(v) };
  }
  if (isInk(v)) {
    const slim = { ...v, source: { ...v.source } };
    delete slim.source.wasm; // the .contract bundle carries the compiled code; only the metadata is needed to decode events
    return { kind: "ink", abi: slim, events: inkEvents(v), note: v.contract?.name ? `ink! contract “${v.contract.name}”` : undefined };
  }
  if (v && Array.isArray(v.abi)) return { kind: "evm", abi: v.abi, events: abiEvents(v.abi), note: "Compiler artifact: using its abi field" };
  if (v && v.output && Array.isArray(v.output.abi)) return { kind: "evm", abi: v.output.abi, events: abiEvents(v.output.abi), note: "Compiler output: using its abi" };
  throw new Error("PortalOps could not tell what this is. Expected a Solidity ABI (JSON array), a compiler artifact with an abi field, or ink! metadata (metadata.json / .contract).");
}

/** The right kind of address placeholder and hint for each contract type. */
export const ADDRESS_HELP = {
  evm: { placeholder: "0x… (20 bytes)", label: "Contract address" },
  ink: { placeholder: "5… (SS58 address)", label: "Contract address (SS58)" },
};
