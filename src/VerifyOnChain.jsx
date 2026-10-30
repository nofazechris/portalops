import { useState } from "react";
import { api } from "./api.js";
import { verifyEventAgainstChain } from "../packages/event-engine/chain-check.ts";
import "./verifyOnChain.css";

const TONE = { verified: "ok", mismatch: "error", not_found: "warn", unavailable: "info", not_applicable: "info" };
const TITLE = {
  verified: "Verified on chain",
  mismatch: "Does not match the chain",
  not_found: "The chain does not know this transaction",
  unavailable: "Could not reach the chain",
  not_applicable: "Not checkable yet",
};
const curl = (rpc, tx) => `curl -s ${rpc} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${tx}"]}'`;

let rpcCache = null;
async function publicRpc() {
  if (rpcCache) return rpcCache;
  try { rpcCache = (await api.networks())?.[0]?.rpcUrl ?? null; } catch { /* the server may be unreachable; the caller falls back */ }
  return rpcCache;
}

/**
 * "Verify against the chain". The check runs in THIS browser, straight against the public Portaldot RPC, so it does not trust PortalOps:
 * the stored event is compared with the transaction receipt the chain returns. If the browser cannot reach the RPC (a network or CORS
 * problem) it asks the PortalOps server to do the same check, and says so.
 */
export default function VerifyOnChain({ event, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null); // { ...result, by: "browser" | "server", rpcUrl }
  const [copied, setCopied] = useState(false);

  async function run() {
    setBusy(true); setRes(null);
    try {
      const rpcUrl = await publicRpc();
      let out = null;
      if (rpcUrl) {
        const r = await verifyEventAgainstChain(event, { rpcUrl });
        if (r.verdict !== "unavailable") out = { ...r, by: "your browser", rpcUrl };
      }
      if (!out) {
        try { out = { ...(await api.verifyEvent(event.id)), by: "the PortalOps server", rpcUrl: rpcUrl ?? undefined }; }
        catch (e) { out = { verdict: "unavailable", summary: e.message || "Could not run the check.", checks: [], by: "your browser", rpcUrl: rpcUrl ?? undefined }; }
      }
      setRes(out);
    } finally { setBusy(false); }
  }

  const copyCmd = async () => {
    try { await navigator.clipboard.writeText(curl(res?.rpcUrl ?? "https://test-evm-rpc-v3.portaldot.dev", event.transactionHash)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  if (event.source && event.source !== "evm") {
    return compact ? null : <div className="voc-note">Checking Rust (ink!) events against the native node is not available yet.</div>;
  }
  return (
    <div className={"voc" + (compact ? " compact" : "")}>
      <button className="voc-btn" disabled={busy} onClick={run}>{busy ? "Asking the chain…" : res ? "Check again" : "Verify against the chain"}</button>
      {!res && !busy && <span className="voc-hint">Compares this event with the transaction receipt from the public Portaldot RPC.</span>}
      {res && (
        <div className="voc-result" role="status">
          <div className={"voc-verdict " + (TONE[res.verdict] ?? "info")}>
            <b>{TITLE[res.verdict] ?? res.verdict}</b>
            <span>{res.summary}</span>
          </div>
          {res.checks?.length > 0 && (
            <ul className="voc-checks">
              {res.checks.map((c) => (
                <li key={c.id} className={c.ok ? "ok" : "bad"}>
                  <i aria-hidden="true">{c.ok ? "✓" : "✕"}</i>
                  <span>{c.label}{c.detail ? <em> {c.detail}</em> : null}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="voc-foot">
            Checked by {res.by}{res.rpcUrl ? <> against <code>{res.rpcUrl.replace(/^https?:\/\//, "")}</code></> : null}
            {typeof res.confirmations === "number" ? ` · ${res.confirmations.toLocaleString()} blocks on top` : ""}.{" "}
            <button className="voc-link" onClick={copyCmd}>{copied ? "Copied" : "Copy a command to check it yourself"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
