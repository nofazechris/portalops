# Receiving webhooks

How to build an endpoint that PortalOps can deliver to, and that nobody else can fool.

## The request

PortalOps sends an HTTP `POST` with a JSON body.

**Headers**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `PortalOps-Webhooks/1.0` |
| `PortalOps-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>`: see [Verify the signature](#verify-the-signature) |
| `PortalOps-Timestamp` | The same `t`, on its own |
| `PortalOps-Event-Id` | The event id (`evt_…`). Your de-duplication key |
| `PortalOps-Delivery-Id` | This delivery's id (`dlv_…`) |
| `PortalOps-Attempt` | `1` on the first try, `2` on the first retry, … |
| `Idempotency-Key` | Same as the event id |

**Body**

```json
{
  "id": "evt_3f2a9c1e5b7d4a60b8c1d2e3f4a5b6c7",
  "type": "event.received",
  "network": "portaldot-v3-testnet",
  "data": {
    "eventName": "Transfer",
    "decoded": true,
    "contractAddress": "0x1111111111111111111111111111111111111111",
    "payload": { "from": "0x0000000000000000000000000000000000000000", "to": "0x2222222222222222222222222222222222222222", "value": "1000000000000000000" },
    "topics": ["0xddf252ad…", "0x000…", "0x000…"],
    "data": "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    "transactionHash": "0x…",
    "blockNumber": 115420,
    "blockHash": "0x…",
    "eventIndex": 0,
    "observedAt": "2026-10-20T09:12:31.204Z",
    "finalityStatus": "included"
  }
}
```

- `payload` holds the decoded arguments. Large numbers are **strings**. It is `null` (and `decoded` is `false`) when the contract has no ABI
  or the log did not match it; `topics` and `data` are always there so you can decode yourself.
- `finalityStatus` is the status **at the moment of this attempt** (see [Finality](concepts.md#finality)).
- The body for a given event is stable, so replays are byte-identical apart from `finalityStatus`.

## Your response

| You return | PortalOps does |
|---|---|
| any `2xx` | marks the delivery `delivered` |
| `408`, `425`, `429`, any `5xx`, a timeout, a connection error | retries with backoff (see [Concepts](concepts.md#webhooks-and-deliveries)) |
| any other `4xx`, or a `3xx` redirect | marks it `failed` and does **not** retry: you told it the request is wrong (redirects are never followed) |

Answer fast (the default timeout is 10 s) and do slow work after responding. Only the first 2 KB of your response is kept (sanitised) in the
attempt history, and a response larger than 64 KB is treated as a permanent failure: never put secrets in responses.

## Verify the signature

Each request is signed with the webhook's secret (`whsec_…`, shown once when the webhook is created):

```
signed_payload = "<t>." + <raw request body, byte for byte>
v1             = hex( HMAC_SHA256( key = the whole secret string, message = signed_payload ) )
```

Rules that make verification actually secure:

1. **Use the raw body.** Parsing the JSON and re-serialising it changes bytes and breaks the signature, and a signature check on parsed
   data protects nothing.
2. **Compare in constant time** (`timingSafeEqual`, `hmac.compare_digest`, `hash_equals`), never with `==`.
3. **Reject old timestamps** (default tolerance 300 s) so a captured request cannot be replayed to you later.
4. **Verify before you parse or act.**
5. **Use the entire secret string as the key**, including the `whsec_` prefix.

### Node.js with the SDK

```ts
import { constructEvent } from "@portalops/sdk";

// Express: the route must receive the raw bytes
app.post("/portal-events", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature"));
    // …
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
});
```

`constructEvent` throws `SignatureVerificationError` (with a `reason` of `malformed`, `expired` or `mismatch`) and never parses an unverified body.
`verifyWebhookSignature` returns `{ ok, reason }` instead of throwing.

### Node.js without the SDK

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t), sig = parts.v1;
  if (!Number.isInteger(t) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

### Python

```python
import hashlib, hmac, time

def verify(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t, sig = int(parts["t"]), parts["v1"]
    except (KeyError, ValueError, AttributeError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

# Flask:  verify(SECRET, request.get_data(), request.headers.get("PortalOps-Signature", ""))
# FastAPI: body = await request.body()
```

### Go

```go
package portalops

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func Verify(secret string, rawBody []byte, header string, tolerance time.Duration) bool {
	var ts, sig string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok { continue }
		switch k { case "t": ts = v; case "v1": sig = v }
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || sig == "" { return false }
	if d := time.Since(time.Unix(t, 0)); d > tolerance || d < -tolerance { return false }
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", t)))
	mac.Write(rawBody)
	given, err := hex.DecodeString(sig)
	return err == nil && hmac.Equal(given, mac.Sum(nil))
}
// net/http: body, _ := io.ReadAll(r.Body); Verify(secret, body, r.Header.Get("PortalOps-Signature"), 5*time.Minute)
```

### PHP

```php
function portalops_verify(string $secret, string $rawBody, string $header, int $tolerance = 300): bool {
    $parts = [];
    foreach (explode(',', $header) as $p) { [$k, $v] = array_pad(explode('=', $p, 2), 2, ''); $parts[$k] = $v; }
    if (!isset($parts['t'], $parts['v1']) || !ctype_digit($parts['t'])) return false;
    $t = (int) $parts['t'];
    if (abs(time() - $t) > $tolerance) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    return hash_equals($expected, $parts['v1']);
}
// $rawBody = file_get_contents('php://input');   $header = $_SERVER['HTTP_PORTALOPS_SIGNATURE'] ?? '';
```

The Node and Python recipes above were run against the real signer. The Go and PHP ones follow the same algorithm but were not executed in this repository's environment: test them against the vector below before relying on them.

**Test vector** (computed independently with `printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac k`):

| secret | `t` | raw body | `v1` |
|---|---|---|---|
| `k` | `1700000000` | `{}` | `c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146` |

If your code produces that `v1` (ignoring the timestamp tolerance, which will reject a 2023 timestamp), it matches the server.

## Idempotency: handle the same event twice

Retries, replays and the occasional lost acknowledgement mean the same event id can reach you more than once. Make processing safe:

```sql
-- one row per processed event; the unique key does the work
CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, processed_at TIMESTAMPTZ DEFAULT now());

-- in the handler, inside the same transaction as your side effect:
INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING;
-- 0 rows inserted  => already handled: return 200 without repeating the side effect
```

An in-memory `Set` (as in the quickstart) only survives until your next restart.

## Where it can be delivered

- **HTTPS only** in production. Plain `http://` is allowed only when the server is explicitly configured for local development.
- **No private targets.** The server refuses URLs that resolve to loopback, private, link-local, cloud-metadata or other internal addresses
  (including IPv6 forms that embed them). The check happens when the webhook is saved **and again on every send**, against the address the
  connection actually uses, so a DNS change after you saved cannot redirect deliveries inward.
- **No redirects are followed.** Give the final URL.
- Developing on your laptop? Use a tunnel (`cloudflared tunnel`, `ngrok http 3000`) and register the tunnel's HTTPS URL.

## Rotating the secret

`POST /api/v1/webhooks/:id/rotate-secret` (or the dashboard) returns a new secret **once** and invalidates the old one **immediately**.
Deploy the new secret to your receiver first if you cannot tolerate a few rejected deliveries; rejected ones (`400`/`401`) are not
retried, so replay any that failed during the switch.

## Test without writing a receiver

1. Create a webhook with `builtinReceiver: true`.
2. **Send test delivery** (dashboard, API or SDK). The hosted receiver verifies the signature and shows you what it saw.
3. Switch its mode to `fail500` or `timeout`, trigger or replay an event, and watch the retry schedule.
4. Switch back to `ok` and replay.

## Security checklist

- [ ] Raw body verified with HMAC and a constant-time compare
- [ ] Timestamp tolerance enforced (≤ 5 minutes)
- [ ] Event id de-duplicated in durable storage
- [ ] Secret in an environment variable or secrets manager, never in source control or logs
- [ ] Endpoint served over HTTPS, answers within a few seconds, returns `2xx` only after durable processing
- [ ] Money-moving logic waits for `finalityStatus: "finalized"`
