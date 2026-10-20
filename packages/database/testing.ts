import { after } from "node:test";
import { randomBytes } from "node:crypto";
import { openStore, type Store } from "./store.ts";

/**
 * A fresh, empty store for one test, on whichever backend the suite is running against:
 *   TEST_DB=sqlite (default)   in-memory SQLite
 *   TEST_DB=postgres           a private schema on the server named by TEST_DATABASE_URL (see scripts/test-postgres.mjs)
 *
 * Every store is closed (and, on PostgreSQL, its schema dropped) when the test file finishes.
 */
export const TEST_BACKEND: "sqlite" | "postgres" = process.env.TEST_DB === "postgres" ? "postgres" : "sqlite";

const opened: Store[] = [];
let hooked = false;

export async function makeTestStore(): Promise<Store> {
  if (!hooked) {
    hooked = true;
    after(async () => { await Promise.allSettled(opened.splice(0).map((s) => s.close())); });
  }
  let store: Store;
  if (TEST_BACKEND === "postgres") {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DB=postgres needs TEST_DATABASE_URL (run `npm run test:pg`, which starts a server for you)");
    store = await openStore(url, { schema: `pops_t_${randomBytes(6).toString("hex")}`, dropSchemaOnClose: true, max: 3 });
  } else {
    store = await openStore(":memory:");
  }
  opened.push(store);
  return store;
}
