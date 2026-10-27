import type { Store } from "../database/store.ts";
import { getExample, listFeatured } from "../examples/catalog.ts";
import { verifySource } from "./verify.ts";

/**
 * Verifies the contracts PortalOps itself deployed, so the registry is never empty and the claim "the code on chain is the code in the repo"
 * is a row anyone can open. Runs in the background at start-up, skips what is already verified, and never throws: the chain being
 * unreachable just means the next start tries again.
 */
export async function seedVerifiedContracts(store: Store, getCode: (address: string) => Promise<string>, verify: typeof verifySource = verifySource): Promise<{ verified: string[]; failed: string[] }> {
  const out = { verified: [] as string[], failed: [] as string[] };
  for (const f of listFeatured()) {
    if (f.origin !== "ours") continue;
    const ex = f.example ? getExample(f.example) : null;
    if (!ex) continue;
    try {
      if (await store.getVerifiedContract(f.address)) continue; // a partial match is already proof; the code on chain never changes
      const code = await getCode(f.address);
      const r = await verify({ source: ex.source, contractName: ex.contractName, evmVersion: ex.compiler.evmVersion, optimizerRuns: ex.compiler.optimizerRuns, onChainCode: code });
      if (!r.ok) { out.failed.push(f.address); continue; }
      await store.saveVerifiedContract({ address: f.address, name: r.name, abi: r.abi, source: ex.source, matchType: r.match, evmVersion: r.settings.evmVersion, optimizerRuns: r.settings.optimizerRuns, compiler: r.compiler, runtimeBytes: r.runtimeBytes });
      out.verified.push(f.address);
    } catch { out.failed.push(f.address); }
  }
  return out;
}
