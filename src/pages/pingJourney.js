// The five stops of a transaction on its way through PortalOps, derived from what the API says about it, so the page can show them lighting up.
//   sent -> captured -> decoded -> finality -> delivered

const FINALITY = { included: "In a block", confirmed: "12+ blocks deep", finalized: "Finalized by the network", orphaned: "Replaced by a reorganisation" };

/**
 * @param {{ hash: string | null, events: any[], sentAt: number | null, capturedAt: number | null }} s
 * @returns {{ id: string, title: string, detail: string, state: "done" | "active" | "waiting" | "bad" }[]}
 */
export function pingJourney(s) {
  const ev = s.events?.[0] ?? null;
  const steps = [];
  const sent = !!s.hash;
  steps.push({ id: "sent", title: "Transaction sent", detail: sent ? `${s.hash.slice(0, 10)}…${s.hash.slice(-6)}` : "waiting for you", state: sent ? "done" : "waiting" });

  const captured = !!ev;
  const secs = captured && s.sentAt && s.capturedAt ? Math.max(0, Math.round((s.capturedAt - s.sentAt) / 100) / 10) : null;
  steps.push({
    id: "captured", title: "Captured by PortalOps",
    detail: captured ? `block #${ev.blockNumber.toLocaleString("en-US")}${secs !== null ? ` · ${secs} s after you sent it` : ""}` : sent ? "reading the chain…" : "",
    state: captured ? "done" : sent ? "active" : "waiting",
  });

  const decoded = captured && ev.decoded && ev.eventName;
  const payload = decoded && ev.payload ? Object.entries(ev.payload).map(([k, v]) => `${k}: ${String(v).length > 28 ? String(v).slice(0, 12) + "…" + String(v).slice(-6) : v}`).join(" · ") : "";
  steps.push({
    id: "decoded", title: "Decoded", detail: decoded ? `${ev.eventName}  ${payload}` : captured ? "stored raw: no ABI for this contract" : "",
    state: decoded ? "done" : captured ? "bad" : "waiting",
  });

  const fin = captured ? ev.finalityStatus : null;
  steps.push({
    id: "finality", title: "Finality", detail: fin ? FINALITY[fin] : "",
    state: fin === "finalized" ? "done" : fin === "orphaned" ? "bad" : captured ? "active" : "waiting",
  });

  const d = captured ? ev.delivery : null;
  steps.push({
    id: "delivered", title: "Delivered as a signed webhook",
    detail: d ? (d.status === "delivered" ? "to the built-in receiver, signature verified" : d.status === "failed" ? "failed: see Diagnostics" : "sending…") : captured ? "queued…" : "",
    state: d?.status === "delivered" ? "done" : d?.status === "failed" ? "bad" : captured ? "active" : "waiting",
  });
  return steps;
}

/** True when there is nothing left to wait for: delivered and finalized (or a dead end). */
export const journeyComplete = (steps) => steps.every((x) => x.state === "done") || steps.some((x) => x.state === "bad");
