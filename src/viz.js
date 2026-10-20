// Pure logic behind the visualizations (finality progression, delivery/retry flow, live timeline).
// No React and no DOM in here, so it is unit-tested directly (src/viz.test.js).

/** Blocks an event must be buried under before PortalOps calls it `confirmed` (a depth heuristic, not protocol finality). */
export const CONFIRMATION_DEPTH = 12;

// --------------------------------------------------------------------------------------------------- formatting
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`.replace(/ 0s$/, "");
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`.replace(/ 0m$/, "");
}

// --------------------------------------------------------------------------------------------------- finality
/**
 * How far along an event is. `headBlock` may be null/undefined when the chain is unreachable: then no depth is shown rather than
 * an invented one.
 *
 *   included ──► confirmed (≥ depth blocks deep) ──► finalized (the node's finalized block passed it, verified)
 *       └──────────────────────────────────────────► orphaned  (its block left the canonical chain)
 */
export function finalityProgress(status, blockNumber, headBlock, depth = CONFIRMATION_DEPTH) {
  const known = Number.isInteger(headBlock) && Number.isInteger(blockNumber);
  const blocksDeep = known ? Math.max(0, headBlock - blockNumber) : null;
  const toGo = blocksDeep === null ? null : Math.max(0, depth - blocksDeep);

  if (status === "orphaned") {
    return {
      status, orphaned: true, blocksDeep, depth, progress: 0,
      steps: [
        { id: "seen", label: "Seen", state: "done", note: `block #${blockNumber}` },
        { id: "orphaned", label: "Orphaned", state: "failed", note: "block replaced" },
        { id: "finalized", label: "Finalized", state: "skipped", note: "never" },
      ],
      summary: "The block this event was in is no longer on the canonical chain (a reorganisation). If the transaction was re-included, it arrives as a new event.",
    };
  }

  const rank = status === "finalized" ? 2 : status === "confirmed" ? 1 : 0;
  const progress = rank >= 1 ? 1 : known ? Math.min(1, blocksDeep / depth) : 0;
  const steps = [
    { id: "seen", label: "Seen", state: "done", note: `block #${blockNumber}` },
    {
      id: "confirmed", label: "Confirmed",
      state: rank >= 1 ? "done" : "current",
      note: rank >= 1 ? `${depth}+ deep` : known ? `${Math.min(blocksDeep, depth)}/${depth} deep` : `${depth} blocks deep`,
    },
    {
      id: "finalized", label: "Finalized",
      state: rank >= 2 ? "done" : rank === 1 ? "current" : "todo",
      note: rank >= 2 ? "network-final" : rank === 1 ? "waiting for the network" : "after confirmed",
    },
  ];

  let summary;
  if (rank === 2) summary = "Finalized by the network and verified canonical. It can no longer be reorganised: safe for irreversible actions.";
  else if (rank === 1) summary = `${depth}+ blocks deep, a depth heuristic. It becomes finalized once the node's finalized block passes it; until then a reorganisation is unlikely but possible.`;
  else if (known && toGo === 0) summary = `Already ${blocksDeep} blocks deep: it is promoted to confirmed on the worker's next pass.`;
  else if (known) summary = `${blocksDeep} of ${depth} blocks deep: ${toGo} more block${toGo === 1 ? "" : "s"} until confirmed. Tip reorganisations are routine, so do not act on money-like events yet.`;
  else summary = `Seen in a block, fewer than ${depth} blocks deep. The current head is unknown right now, so the exact depth cannot be shown.`;

  return { status, orphaned: false, blocksDeep, depth, progress, steps, summary };
}

// --------------------------------------------------------------------------------------------------- delivery flow
/** Mirrors the server's retry rules (packages/webhook-engine/retry.ts) so the explanation of a failure matches what happened. */
export function isRetryableAttempt(a) {
  const status = a.responseStatus;
  if (status === null || status === undefined) return !["blocked_target", "invalid_url", "response_too_large"].includes(a.errorCode ?? "");
  if (status >= 200 && status < 300) return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function failureReason(lastAttempt, attemptCount) {
  if (!lastAttempt) return "No attempt was recorded.";
  if (!isRetryableAttempt(lastAttempt)) {
    const what = lastAttempt.responseStatus ? `HTTP ${lastAttempt.responseStatus}` : lastAttempt.errorCode;
    return `Not retried: ${what} is a permanent error. Fix the cause, then replay.`;
  }
  return `Retries exhausted after ${attemptCount} attempt${attemptCount === 1 ? "" : "s"} (attempt or time limit). Fix the cause, then replay.`;
}

const ms = (iso) => Date.parse(iso);

/**
 * A delivery as a left-to-right sequence of nodes:
 *   queued ─ wait ─ attempt 1 ─ wait ─ attempt 2 ─ … ─ delivered | failed | (next retry in 4m, retrying)
 * `nowMs` drives the live countdown of a scheduled retry.
 */
export function deliveryFlow(d, nowMs = Date.now()) {
  const attempts = [...(d.attempts ?? [])].sort((a, b) => a.attemptNumber - b.attemptNumber);
  const nodes = [{ kind: "queued", id: "queued", label: d.kind === "replay" ? "Replay queued" : "Queued", at: d.createdAt }];

  let prevEnd = ms(d.createdAt);
  attempts.forEach((a, i) => {
    const start = ms(a.startedAt);
    if (i > 0 || start - prevEnd > 1000) nodes.push({ kind: "wait", id: `wait-${a.attemptNumber}`, ms: Math.max(0, start - prevEnd), label: i === 0 ? "waited" : "backoff" });
    const ok = a.responseStatus !== null && a.responseStatus !== undefined && a.responseStatus >= 200 && a.responseStatus < 300;
    nodes.push({
      kind: "attempt", id: `attempt-${a.attemptNumber}`, n: a.attemptNumber, ok,
      result: a.responseStatus ?? a.errorCode ?? "error", durationMs: a.responseDurationMs, at: a.startedAt,
      detail: a.sanitisedResponse ?? null, retryable: !ok && isRetryableAttempt(a),
    });
    prevEnd = ms(a.finishedAt);
  });

  const last = attempts[attempts.length - 1];
  if (d.status === "delivered") {
    nodes.push({ kind: "end", id: "end", tone: "ok", label: "Delivered", note: last ? `after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}` : "" });
  } else if (d.status === "failed") {
    nodes.push({ kind: "end", id: "end", tone: "bad", label: "Failed", note: failureReason(last, attempts.length) });
  } else {
    const until = d.nextAttemptAt ? ms(d.nextAttemptAt) : null;
    nodes.push({ kind: "wait", id: "wait-next", pending: true, ms: until === null ? null : Math.max(0, until - nowMs), label: attempts.length ? "next retry in" : "first attempt in" });
    nodes.push({ kind: "end", id: "end", tone: "pending", label: d.status === "retrying" ? "Retrying" : "Queued", note: "" });
  }

  const summary =
    d.status === "delivered" ? `Delivered${attempts.length > 1 ? ` on attempt ${attempts.length}` : " on the first attempt"}.`
    : d.status === "failed" ? failureReason(last, attempts.length)
    : d.status === "retrying" ? `Attempt ${attempts.length} failed; retrying automatically with backoff.`
    : "Waiting for the first attempt.";
  return { nodes, summary, attempts: attempts.length };
}

// --------------------------------------------------------------------------------------------------- live timeline
/** Counts per minute for the last `minutes` minutes, oldest first, for the sparkline. */
export function bucketByMinute(events, nowMs, minutes = 15) {
  const buckets = new Array(minutes).fill(0);
  for (const e of events) {
    const age = Math.floor((nowMs - Date.parse(e.observedAt)) / 60_000);
    if (age >= 0 && age < minutes) buckets[minutes - 1 - age]++;
  }
  return buckets;
}

/** Groups newest-first events under their block, keeping order. */
export function groupByBlock(events) {
  const groups = [];
  for (const e of events) {
    const g = groups[groups.length - 1];
    if (g && g.block === e.blockNumber) g.events.push(e);
    else groups.push({ block: e.blockNumber, events: [e] });
  }
  return groups;
}

/** Ids in `items` that were not in `previous` (a Set). With no previous snapshot nothing is "new": the first load is not news. */
export function newIds(previous, items) {
  if (!previous) return [];
  return items.filter((e) => !previous.has(e.id)).map((e) => e.id);
}
