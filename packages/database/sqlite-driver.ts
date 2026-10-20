import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Row, SqlDriver } from "./driver.ts";

const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "schema.sql");

type SqlParam = string | number | bigint | null | Uint8Array;
const bind = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : (p as SqlParam)));

/** The operations that actually touch the connection. Shared by the root driver and the transaction view. */
class Ops {
  protected readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  protected rawAll(sql: string, params?: unknown[]): Row[] { return this.db.prepare(sql).all(...bind(params)) as Row[]; }
  protected rawRun(sql: string, params?: unknown[]): { changes: number } { return { changes: Number(this.db.prepare(sql).run(...bind(params)).changes) }; }
}

/**
 * SQLite behind the async driver interface. SQLite has one connection and statements run synchronously, so the only hazard
 * of going async is INTERLEAVING: while one caller holds an open transaction across `await`s, an unrelated request must not
 * slip a statement into it (it would be committed or rolled back along with it). Transactions therefore take a gate, and all
 * non-transaction calls wait at the same gate.
 */
export class SqliteDriver extends Ops implements SqlDriver {
  readonly dialect = "sqlite" as const;
  private inTx = false;
  private waiters: (() => void)[] = [];

  /** Opens (and initialises) the database synchronously, so `new Store()` is usable immediately. */
  constructor(path = ":memory:") {
    super(new DatabaseSync(path));
    if (path !== ":memory:") {
      // The API and the worker are separate processes sharing this file.
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    }
    this.db.exec(readFileSync(SCHEMA, "utf8"));
    this.migrate();
  }

  /** Brings databases created by an earlier schema up to date. */
  private migrate(): void {
    const cols = (this.db.prepare("PRAGMA table_info(projects)").all() as Row[]).map((c) => c.name as string);
    const add = (name: string, ddl: string) => { if (!cols.includes(name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`); };
    add("description", "description TEXT");
    add("owner_id", "owner_id TEXT REFERENCES users(id) ON DELETE CASCADE");
    add("kind", "kind TEXT NOT NULL DEFAULT 'user'");
  }

  /**
   * Gate: callers loop `while (this.inTx) await this.wake()` INLINE and then act with no `await` in between. Several waiters are
   * released together when a transaction ends, so each must re-check the flag synchronously after resuming; a helper function
   * that returned a promise would add a microtask hop between the check and the action and let another waiter slip in.
   */
  private wake(): Promise<void> {
    return new Promise<void>((r) => this.waiters.push(r));
  }

  async all(sql: string, params?: unknown[]): Promise<Row[]> {
    while (this.inTx) await this.wake();
    return this.rawAll(sql, params);
  }
  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    while (this.inTx) await this.wake();
    return this.rawRun(sql, params);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    while (this.inTx) await this.wake();
    this.inTx = true; // checked and set with no await in between: atomic
    this.db.exec("BEGIN IMMEDIATE");
    const db = this.db;
    // The transaction's own view bypasses the gate; nested transaction() calls just join the open one.
    const tx: SqlDriver = new (class extends Ops implements SqlDriver {
      readonly dialect = "sqlite" as const;
      async all(sql: string, params?: unknown[]) { return this.rawAll(sql, params); }
      async run(sql: string, params?: unknown[]) { return this.rawRun(sql, params); }
      async transaction<U>(inner: (t: SqlDriver) => Promise<U>): Promise<U> { return inner(this); }
      async close() { /* owned by the root driver */ }
    })(db);
    try {
      const out = await fn(tx);
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTx = false;
      const w = this.waiters; this.waiters = [];
      for (const r of w) r();
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
