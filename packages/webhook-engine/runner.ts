import { randomUUID } from "node:crypto";
import type { NormalizedEvent, WebhookAttempt, WebhookEndpoint } from "../shared-types/index.ts";
import type { Store } from "../database/store.ts";
import { decryptSecret } from "../database/secrets.ts";
import { planNext } from "./retry.ts";
import { sendWebhook } from "./send.ts";
import { signHeader } from "./sign.ts";
import type { GuardOptions } from "./url-guard.ts";

export interface RunnerContext {
  store: Store;
  /** 32-byte key used to decrypt endpoint secrets. */
  encryptionKey: Buffer;
  guard?: GuardOptions;
  now?: () => Date;
  random?: () => number;
}

/** The exact JSON body consumers receive. Stable for a given event so replays are byte-identical. */
export function buildWebhookBody(event: NormalizedEvent): string {
  return JSON.stringify({
    id: event.id,
    type: "event.received",
    network: event.network,
    data: {
      eventName: event.eventName,
      decoded: event.decoded,
      contractAddress: event.contractAddress,
      payload: event.payload,
      topics: event.topics,
      data: event.data,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      eventIndex: event.eventIndex,
      observedAt: event.observedAt,
      finalityStatus: event.finalityStatus,
    },
  });
}

const matches = (ep: WebhookEndpoint, e: NormalizedEvent) =>
  ep.enabled && (ep.eventFilter.length === 0 || (e.eventName !== null && ep.eventFilter.includes(e.eventName)));

/** Creates the initial delivery for every enabled endpoint of the project whose filter matches. Idempotent. */
export async function enqueueEvent(store: Store, event: NormalizedEvent, now: Date = new Date()): Promise<string[]> {
  const ids: string[] = [];
  const endpoints = await store.listEndpoints(event.projectId);
  for (const ep of endpoints) {
    if (!matches(ep, event)) continue;
    const id = await store.createDelivery(event.id, ep.id, "initial", now);
    if (id) ids.push(id);
  }
  // Automation rules (PRD 8.12): "when this event occurs, deliver to that endpoint". Deduplicated by the same
  // (event, endpoint) uniqueness as plain subscriptions, so a rule and a filter pointing at one endpoint send once.
  for (const rule of await store.listAutomations(event.projectId)) {
    if (!rule.enabled) continue;
    if (rule.triggerEventName !== null && rule.triggerEventName !== event.eventName) continue;
    if (rule.triggerContract !== null && rule.triggerContract !== event.contractAddress) continue;
    const ep = endpoints.find((e) => e.id === rule.endpointId);
    if (!ep || !ep.enabled) continue;
    const id = await store.createDelivery(event.id, ep.id, "initial", now);
    if (id) {
      ids.push(id);
      await store.log("info", "automation", `Rule "${rule.name}" queued delivery ${id} for event ${event.id}`, { ruleId: rule.id }, event.projectId);
    }
  }
  return ids;
}

/**
 * Replay re-delivers the STORED event to one endpoint as a brand-new delivery (PRD §8.10, §12.5).
 * It never touches the chain: the original transaction is not resubmitted and the event row is unchanged.
 */
export async function replayEvent(store: Store, eventId: string, endpointId: string, now: Date = new Date()): Promise<string> {
  const event = await store.getEvent(eventId);
  if (!event) throw new Error(`Unknown event ${eventId}`);
  const ep = await store.getEndpoint(endpointId);
  if (!ep) throw new Error(`Unknown endpoint ${endpointId}`);
  if (ep.projectId !== event.projectId) throw new Error("Endpoint and event belong to different projects.");
  const id = await store.createDelivery(eventId, endpointId, "replay", now);
  if (!id) throw new Error("Could not create replay delivery.");
  await store.log("info", "replay", `Replay queued for event ${eventId} -> endpoint ${endpointId}`, { deliveryId: id }, event.projectId);
  return id;
}

/** Performs one attempt for one delivery and persists the attempt plus the next scheduling decision. */
export async function attemptDelivery(ctx: RunnerContext, deliveryId: string): Promise<{ status: string; attempt: WebhookAttempt }> {
  const { store } = ctx;
  const now = ctx.now ?? (() => new Date());
  const delivery = await store.getDelivery(deliveryId);
  if (!delivery) throw new Error(`Unknown delivery ${deliveryId}`);
  const event = await store.getEvent(delivery.eventId);
  const found = await store.getEndpointWithSecret(delivery.endpointId);
  if (!event || !found) throw new Error(`Delivery ${deliveryId} references a missing event or endpoint.`);
  const { endpoint, encryptedSecret } = found;

  const attemptNumber = delivery.attemptCount + 1;
  const startedAt = now();
  const body = buildWebhookBody(event);
  const secret = decryptSecret(encryptedSecret, ctx.encryptionKey);
  const { timestamp, header } = signHeader(secret, body, startedAt);

  const result = await sendWebhook(
    endpoint.url,
    body,
    {
      "portalops-signature": header,
      "portalops-timestamp": String(timestamp),
      "portalops-event-id": event.id,
      "portalops-delivery-id": delivery.id,
      "portalops-attempt": String(attemptNumber),
      "idempotency-key": event.id,
    },
    { timeoutMs: endpoint.retryPolicy.timeoutMs, guard: ctx.guard },
  );

  const finishedAt = now();
  const next = planNext(result, attemptNumber, new Date(delivery.createdAt), endpoint.retryPolicy, finishedAt, ctx.random);

  const lastError = next.action === "deliver" ? null : result.errorCode ?? (result.status !== null ? `HTTP ${result.status}` : "unknown_error");
  const status = next.action === "deliver" ? "delivered" : next.action === "retry" ? "retrying" : "failed";
  const nextAttemptAt = next.action === "retry" ? new Date(finishedAt.getTime() + next.delayMs).toISOString() : null;

  const attempt: WebhookAttempt = {
    id: "att_" + randomUUID().replaceAll("-", "").slice(0, 24),
    deliveryId: delivery.id,
    attemptNumber,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    responseStatus: result.status,
    responseDurationMs: result.durationMs,
    sanitisedResponse: result.sanitisedResponse,
    errorCode: result.errorCode,
  };
  await store.recordAttempt(attempt, { status, nextAttemptAt, lastError });
  await store.log(
    status === "delivered" ? "info" : status === "retrying" ? "warn" : "error",
    "webhook",
    `Delivery ${delivery.id} attempt ${attemptNumber} -> ${status}${result.status !== null ? ` (HTTP ${result.status})` : ` (${result.errorCode})`}${next.action === "fail" ? ` [${next.reason}]` : ""}`,
    { eventId: event.id, endpointId: endpoint.id, nextAttemptAt },
    event.projectId,
  );
  return { status, attempt };
}

/** Processes everything currently due. Returns how many attempts ran. Safe to call on a timer. */
export async function runDueDeliveries(ctx: RunnerContext, limit = 20): Promise<number> {
  const now = (ctx.now ?? (() => new Date()))();
  const due = await ctx.store.dueDeliveries(now, limit);
  let attempted = 0;
  for (const d of due) {
    // The lease covers the longest possible attempt (timeout) with headroom; recordAttempt then sets the real next time.
    const found = await ctx.store.getEndpoint(d.endpointId);
    if (!await ctx.store.claimDelivery(d.id, now, (found?.retryPolicy.timeoutMs ?? 10_000) + 30_000)) continue; // another worker has it
    await attemptDelivery(ctx, d.id);
    attempted++;
  }
  return attempted;
}
