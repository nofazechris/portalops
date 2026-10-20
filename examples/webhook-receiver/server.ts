import http from "node:http";
import { verifySignature, SIGNATURE_HEADER } from "../../packages/webhook-engine/sign.ts";

/**
 * Reference webhook receiver and built-in test target (PRD §8.9).
 * It shows the three things every consumer must do: verify the signature over the RAW body,
 * reject stale timestamps, and treat the event id as an idempotency key.
 *
 * Failure injection for demos: POST /__control {"mode":"ok"|"fail500"|"fail400"|"timeout"}.
 */
export type ReceiverMode = "ok" | "fail500" | "fail400" | "timeout";

export interface Receiver {
  url: string;
  port: number;
  setMode(m: ReceiverMode): void;
  /** Event ids processed successfully (de-duplicated). */
  processed: Set<string>;
  /** Every request that arrived, including failures and duplicates. */
  requests: { eventId: string | null; deliveryId: string | null; attempt: number | null; outcome: string; signatureOk: boolean }[];
  close(): Promise<void>;
}

export async function startReceiver(secret: string, port = 0, host = "127.0.0.1"): Promise<Receiver> {
  let mode: ReceiverMode = "ok";
  const processed = new Set<string>();
  const requests: Receiver["requests"] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/__control" && req.method === "POST") {
        mode = (JSON.parse(raw || "{}").mode ?? "ok") as ReceiverMode;
        res.writeHead(200).end(JSON.stringify({ mode }));
        return;
      }

      const eventId = (req.headers["portalops-event-id"] as string) ?? null;
      const deliveryId = (req.headers["portalops-delivery-id"] as string) ?? null;
      const attempt = req.headers["portalops-attempt"] ? Number(req.headers["portalops-attempt"]) : null;
      const verdict = verifySignature(secret, raw, req.headers[SIGNATURE_HEADER] as string | undefined);
      const note = (outcome: string) => requests.push({ eventId, deliveryId, attempt, outcome, signatureOk: verdict.ok });

      if (!verdict.ok) {
        note(`rejected:${verdict.reason}`);
        res.writeHead(401).end(JSON.stringify({ error: "invalid signature", reason: verdict.reason }));
        return;
      }
      if (mode === "timeout") {
        note("timeout"); // never answer
        return;
      }
      if (mode === "fail500") {
        note("fail500");
        res.writeHead(500).end(JSON.stringify({ error: "simulated internal error" }));
        return;
      }
      if (mode === "fail400") {
        note("fail400");
        res.writeHead(400).end(JSON.stringify({ error: "simulated bad request" }));
        return;
      }
      const duplicate = eventId !== null && processed.has(eventId);
      if (eventId) processed.add(eventId); // idempotent: a replay of the same event id is acknowledged but not re-processed
      note(duplicate ? "ok:duplicate-ignored" : "ok");
      res.writeHead(200).end(JSON.stringify({ received: true, duplicate }));
    });
  });

  await new Promise<void>((r) => server.listen(port, host, r));
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://${host}:${actual}/webhook`,
    port: actual,
    setMode: (m) => { mode = m; },
    processed,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// Run standalone:  RECEIVER_SECRET=whsec_... node examples/webhook-receiver/server.ts
if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href || process.argv[1]?.endsWith("server.ts")) {
  const secret = process.env.RECEIVER_SECRET;
  if (secret) {
    const r = await startReceiver(secret, Number(process.env.PORT || 4010));
    console.log(`Webhook receiver listening on ${r.url}  (POST /__control {"mode":"fail500"} to inject failures)`);
  }
}
