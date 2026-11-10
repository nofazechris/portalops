import test from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./test-harness.ts";

// A signed test delivery must carry a NEW event id every time, in the header as well as the body. The built-in receiver de-duplicates on the header,
// so a fixed header id made every test after the very first one come back 200 but be recorded as a duplicate. (The playground receiver is shared
// by all visitors, so a visitor's first test was usually already "a duplicate" of somebody else's.)

test("playground test delivery: every test is a new event, never a duplicate of the last", async (t) => {
  const h = await startApi(undefined, { trustedProxyHops: 1 });
  t.after(() => h.close());
  await h.store.createProject({ ownerId: null, name: "Playground", networkId: "portaldot-v3-testnet", kind: "playground" });
  const send = async (ip: string) => {
    const r = await fetch(h.base + "/api/v1/playground/test-delivery", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}" });
    return { status: r.status, json: (await r.json()) as any };
  };
  for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
    const r = await send(ip);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.ok, true, JSON.stringify(r.json));
  }
  const pg = (await (await fetch(h.base + "/api/v1/playground")).json()) as any;
  const seen = pg.data.receiver as { outcome: string; eventId: string | null; signatureOk: boolean }[];
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.outcome), ["ok", "ok", "ok"], "no test is reported as a duplicate");
  assert.ok(seen.every((s) => s.signatureOk));
  const ids = seen.map((s) => s.eventId);
  assert.equal(new Set(ids).size, 3, "three different event ids");
  assert.ok(ids.every((id) => id !== "test" && /^evt_test_[0-9a-f]{16}$/.test(id ?? "")), "real-looking unique ids, not the literal 'test'");
});

test("dashboard webhook test: repeated tests to the built-in receiver are each a new event too", async (t) => {
  const h = await startApi();
  t.after(() => h.close());
  const write = await h.mkKey("write");
  const auth = { "content-type": "application/json", authorization: `Bearer ${write}` };
  const created = (await (await fetch(h.base + `/api/v1/projects/${h.project.id}/webhooks`, { method: "POST", headers: auth, body: JSON.stringify({ builtinReceiver: true }) })).json()) as any;
  assert.ok(created.data?.id, JSON.stringify(created));
  for (let i = 0; i < 2; i++) {
    const r = (await (await fetch(h.base + `/api/v1/webhooks/${created.data.id}/test`, { method: "POST", headers: auth, body: "{}" })).json()) as any;
    assert.equal(r.data.ok, true, JSON.stringify(r));
  }
  const rec = (await (await fetch(h.base + `/api/v1/webhooks/${created.data.id}/receiver`, { headers: auth })).json()) as any;
  const requests = rec.data.requests as { outcome: string; eventId: string | null; deliveryId: string | null }[];
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((q) => q.outcome), ["ok", "ok"]);
  assert.equal(new Set(requests.map((q) => q.eventId)).size, 2);
  assert.ok(requests.every((q) => q.eventId !== "test" && q.deliveryId !== "test"));
});
