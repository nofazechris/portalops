import { SqlStore } from "./sql-store.ts";
import { SqliteDriver } from "./sqlite-driver.ts";

export * from "./records.ts";
export { SqlStore };
export type { Row, SqlDriver } from "./driver.ts";

/** The store type to use in signatures: works for every backend. */
export type Store = SqlStore;

/** SQLite-backed store. `new Store()` / `new Store(path)` open SQLite synchronously (handy for tests and local development). */
export class SqliteStore extends SqlStore {
  constructor(path = ":memory:") {
    super(new SqliteDriver(path));
  }
}
export const Store = SqliteStore;

export interface OpenStoreOptions {
  /** PostgreSQL only: put the tables in this schema. Used to isolate tests on a shared server. */
  schema?: string;
  /** PostgreSQL only: drop that schema on close. Tests only. */
  dropSchemaOnClose?: boolean;
  /** PostgreSQL only: pool size. */
  max?: number;
}

/**
 * Opens the database named by `url`:
 *   postgres://user:pass@host:5432/db   PostgreSQL
 *   sqlite::memory: | :memory:          in-memory SQLite
 *   sqlite:/path/file.sqlite | /path    SQLite file
 */
export async function openStore(url: string, opts: OpenStoreOptions = {}): Promise<SqlStore> {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const { PgDriver } = await import("./pg-driver.ts"); // only loads the driver when PostgreSQL is actually used
    return new SqlStore(await PgDriver.open({ connectionString: url, ...opts }));
  }
  const path = url.replace(/^sqlite:/i, "");
  return new SqliteStore(path === "" || path === ":memory:" ? ":memory:" : path);
}

/** A form of the URL that is safe to print: the password is removed. */
export function describeDatabase(url: string): string {
  if (!/^postgres(ql)?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    return `postgres://${u.username ? u.username + "@" : ""}${u.host}${u.pathname}`;
  } catch {
    return "postgres://(unparseable url)";
  }
}
