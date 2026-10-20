import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { toPgPlaceholders, type Row, type SqlDriver } from "./driver.ts";

const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "schema.pg.sql");
const SCHEMA_LOCK_KEY = 727_274; // arbitrary constant: serialises schema creation across processes starting together

export interface PgOptions {
  connectionString: string;
  /**
   * Put every table in this schema (created if missing) instead of `public`. Used to give each test its own isolated copy of the
   * database on one server. Names are validated; they are interpolated into DDL, never taken from user input.
   */
  schema?: string;
  /** Drop the schema (and everything in it) when the driver closes. Tests only. */
  dropSchemaOnClose?: boolean;
  /** Maximum pooled connections. Default 10. */
  max?: number;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult> };

const norm = (params?: unknown[]) => (params ?? []).map((p) => (p === undefined ? null : p));

class PgTx implements SqlDriver {
  readonly dialect = "postgres" as const;
  private readonly q: Queryable;
  constructor(q: Queryable) { this.q = q; }
  async all(sql: string, params?: unknown[]): Promise<Row[]> { return (await this.q.query(toPgPlaceholders(sql), norm(params))).rows as Row[]; }
  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> { return { changes: (await this.q.query(toPgPlaceholders(sql), norm(params))).rowCount ?? 0 }; }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> { return fn(this); } // already inside one
  async close(): Promise<void> { /* owned by the root driver */ }
}

/**
 * PostgreSQL behind the same driver interface, using a connection pool. Each non-transaction call takes a connection from the
 * pool; a transaction pins ONE connection for its whole duration, so concurrent requests never share a transaction.
 */
export class PgDriver extends PgTx {
  private readonly pool: pg.Pool;
  private readonly opts: PgOptions;

  private constructor(pool: pg.Pool, opts: PgOptions) {
    super(pool);
    this.pool = pool;
    this.opts = opts;
  }

  static async open(opts: PgOptions): Promise<PgDriver> {
    if (opts.schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(opts.schema)) throw new Error(`Invalid schema name: ${opts.schema}`);

    if (opts.schema) {
      const admin = new pg.Client({ connectionString: opts.connectionString });
      await admin.connect();
      try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`); } finally { await admin.end(); }
    }

    const pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
    });
    // An idle client erroring (server restart, network drop) must not crash the process: the pool replaces it.
    pool.on("error", (e) => console.error("postgres pool error:", e.message));

    // Create/upgrade tables under a TRANSACTION-scoped advisory lock so the API and the worker can start at the same moment.
    // Transaction scope (not session scope) matters behind a transaction-mode pooler such as Neon's `-pooler` endpoint, where
    // consecutive statements may run on different server connections: a session lock could be taken on one and leak on another.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
        await client.query(readFileSync(SCHEMA, "utf8"));
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    } finally {
      client.release();
    }
    return new PgDriver(pool, opts);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const out = await fn(new PgTx(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {}); // the original error is the one worth reporting
        throw e;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    if (this.opts.schema && this.opts.dropSchemaOnClose) {
      const admin = new pg.Client({ connectionString: this.opts.connectionString });
      await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS ${this.opts.schema} CASCADE`); } finally { await admin.end(); }
    }
  }
}
